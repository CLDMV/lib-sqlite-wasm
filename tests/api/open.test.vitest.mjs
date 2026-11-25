/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/api/open.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:54-08:00 (1795600254)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:50:54-08:00 (1795600254)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDriver } from "../../src/vfs/memory.mts";
import { install, sharedMemory } from "../../src/vfs/registry.mts";
import { files, memory, rejected, sqlite, thrown, unique } from "./helpers.mjs";

const restore = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
});

/** Stands in `driver` for the "fs" storage for one test. */
function fakeFs(create) {
	const previous = install("fs", async () => ({ create }));
	restore.push(() => install("fs", previous));
}

/** The settings a connection ended up with. */
function settings(db) {
	return {
		journal: db.pragma.get("journal_mode"),
		locking: db.pragma.get("locking_mode"),
		sync: db.pragma.get("synchronous"),
		foreign: db.pragma.get("foreign_keys")
	};
}

describe("sqlite.open", () => {
	it("defaults to WAL with exclusive locking, synchronous NORMAL and foreign keys on", async () => {
		const name = unique("defaults");
		const db = await memory(name);
		expect(settings(db)).toEqual({ journal: "wal", locking: "exclusive", sync: 1, foreign: 1 });
		expect(db.info).toMatchObject({ path: name, storage: "memory", open: true, transaction: false });
		db.close();
		expect(db.info.open).toBe(false);
	});

	it("applies journal, sync and foreign options", async () => {
		const truncate = await memory(unique(), { journal: "truncate", sync: "full", foreign: false });
		expect(settings(truncate)).toEqual({ journal: "truncate", locking: "normal", sync: 2, foreign: 0 });
		const remove = await memory(unique(), { journal: "delete", sync: "off" });
		expect(settings(remove)).toEqual({ journal: "delete", locking: "normal", sync: 0, foreign: 1 });
		const extra = await memory(unique(), { sync: "extra" });
		expect(extra.pragma.get("synchronous")).toBe(3);
		for (const db of [truncate, remove, extra]) db.close();
	});

	it("keeps a WAL file while open and removes it on a clean close", async () => {
		const name = unique("wal");
		const db = await memory(name);
		db.execute("create table t (x); insert into t values (1)");
		expect(files(name)).toEqual([name, `${name}-wal`]);
		db.close();
		expect(files(name)).toEqual([name]);
	});

	it("leaves an empty journal in truncate mode and none in delete mode", async () => {
		const truncated = unique("truncate");
		const db = await memory(truncated, { journal: "truncate" });
		db.execute("create table t (x); insert into t values (1)");
		expect(files(truncated)).toEqual([truncated, `${truncated}-journal`]);
		expect(sharedMemory().contents(`${truncated}-journal`)).toHaveLength(0);
		db.close();
		const deleted = unique("delete");
		const other = await memory(deleted, { journal: "delete" });
		other.execute("create table t (x); insert into t values (1)");
		expect(files(deleted)).toEqual([deleted]);
		other.close();
	});

	it("reopens a file that is in WAL mode, in any journal mode", async () => {
		const name = unique("reopen");
		const first = await memory(name);
		first.execute("create table t (x); insert into t values ('kept')");
		first.close();
		// The header still says WAL: reopening must set exclusive locking before the first read.
		expect(sharedMemory().contents(name)[18]).toBe(2);
		const again = await memory(name);
		expect(again.prepare("select x from t").pluck.get()).toBe("kept");
		again.close();
		const readonly = await memory(name, { readonly: true });
		expect(readonly.prepare("select x from t").pluck.get()).toBe("kept");
		expect(readonly.pragma.get("locking_mode")).toBe("exclusive");
		readonly.close();
		const rollback = await memory(name, { journal: "truncate" });
		expect(settings(rollback)).toMatchObject({ journal: "truncate", locking: "normal" });
		expect(rollback.prepare("select x from t").pluck.get()).toBe("kept");
		rollback.close();
		expect(sharedMemory().contents(name)[18]).toBe(1);
	});

	it("opens read-only and without create", async () => {
		const name = unique("ro");
		(await memory(name)).execute("create table t (x)").close();
		const db = await memory(name, { readonly: true, create: true });
		expect(thrown(() => db.execute("insert into t values (1)"))).toMatchObject({ code: "SQLITE_READONLY" });
		db.close();
		for (const options of [{ create: false }, { readonly: true }]) {
			const error = await rejected(memory(unique("missing"), options));
			expect(error).toBeInstanceOf(sqlite.error);
			expect(error).toMatchObject({ code: "SQLITE_CANTOPEN", number: 14, message: "unable to open database file" });
		}
	});

	it("uses memory for :memory: and the empty name, whatever the storage", async () => {
		for (const name of [":memory:", ""]) {
			const db = await sqlite.open(name, { storage: "fs" });
			expect(db.info.storage).toBe("memory");
			expect(db.pragma.get("journal_mode")).not.toBe("wal");
			db.execute("create table t (x)");
			db.close();
		}
	});

	it("opens real files with storage fs, and with auto under Node", async () => {
		const directory = mkdtempSync(join(tmpdir(), "sqlite-wasm-open-"));
		restore.push(() => rmSync(directory, { recursive: true, force: true }));
		const path = join(directory, "auto.db");
		const db = await sqlite.open(path, { journal: "delete" });
		expect(db.info.storage).toBe("fs");
		db.execute("create table t (x); insert into t values (1)");
		// A second connection in this process brings its own fs driver object; both route to one file.
		const second = await sqlite.open(path, { storage: "fs", journal: "delete", timeout: 0 });
		expect(second.info.storage).toBe("fs");
		second.close();
		db.close();
		expect(existsSync(path)).toBe(true);
		const again = await sqlite.open(path, { storage: "fs" });
		expect(again.prepare("select x from t").pluck.get()).toBe(1);
		expect(again.pragma.get("journal_mode")).toBe("wal");
		again.close();
	});

	it("fails clearly for OPFS outside a browser worker", async () => {
		const error = await rejected(sqlite.open(unique(), { storage: "opfs" }));
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_CANTOPEN", message: expect.stringMatching(/OPFS is not available/) });
	});

	it("validates its arguments", async () => {
		const cases = [
			[5, {}, /path must be a string/],
			["x.db", null, /options must be an object/],
			["x.db", "memory", /options must be an object/],
			["x.db", { storage: "disk" }, /unknown storage "disk"/],
			["x.db", { storage: "toString" }, /unknown storage/],
			["x.db", { readonly: "yes" }, /readonly option must be a boolean/],
			["x.db", { bigint: 1 }, /bigint option must be a boolean/],
			["x.db", { journal: "wal2" }, /journal must be one of wal, truncate, delete/],
			["x.db", { sync: "fast" }, /sync must be one of/],
			["x.db", { timeout: -1 }, /timeout must be a non-negative integer/],
			["x.db", { timeout: 1.5 }, /timeout/]
		];
		for (const [path, options, message] of cases) {
			const error = await rejected(sqlite.open(path, options));
			expect(error).toBeInstanceOf(TypeError);
			expect(error.message).toMatch(message);
		}
	});

	it("waits for a lock up to the timeout, then reports SQLITE_BUSY", async () => {
		const name = unique("busy");
		const holder = await memory(name, { journal: "truncate" });
		holder.execute("create table t (x); begin immediate");
		const impatient = await memory(name, { journal: "truncate", timeout: 0 });
		expect(thrown(() => impatient.execute("begin immediate; commit"))).toMatchObject({ code: "SQLITE_BUSY" });
		const patient = await memory(name, { journal: "truncate", timeout: 40 });
		const started = performance.now();
		expect(thrown(() => patient.execute("begin immediate"))).toMatchObject({ code: "SQLITE_BUSY" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(30);
		holder.execute("commit");
		patient.execute("begin immediate; insert into t values (1); commit");
		for (const db of [holder, impatient, patient]) db.close();
	});

	it("refuses a second connection to a WAL database that is open", async () => {
		const name = unique("exclusive");
		const owner = await memory(name);
		owner.execute("create table t (x)");
		const error = await rejected(memory(name, { timeout: 0 }));
		expect(error).toMatchObject({ code: "SQLITE_BUSY" });
		owner.close();
		// The failed open released its claim on the name, so it opens normally now.
		(await memory(name)).close();
	});

	it("reports a file that isn't a database", async () => {
		const name = unique("garbage");
		const driver = sharedMemory();
		driver.open(name, 1e9, 6);
		driver.write(1e9, new TextEncoder().encode("this is not an SQLite database, just text padding it out ".repeat(4)), 0);
		driver.close(1e9);
		expect(await rejected(memory(name))).toMatchObject({ code: "SQLITE_NOTADB", number: 26 });
	});

	it("passes the driver factory what it opens, and refuses one name on two drivers", async () => {
		const calls = [];
		const driver = new MemoryDriver();
		fakeFs((options) => {
			calls.push(options);
			return driver;
		});
		const name = unique("routed");
		const db = await sqlite.open(name, { storage: "fs", timeout: 10 });
		db.execute("create table t (x); insert into t values (1)");
		expect(calls).toEqual([{ path: name, readonly: false, create: true, timeout: 10 }]);
		expect(driver.files()).toContain(name);
		expect(files(name)).toEqual([]);
		expect(db.info.storage).toBe("fs");
		const error = await rejected(memory(name));
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_CANTOPEN", message: `"${name}" is already open with another storage driver` });
		db.close();
		(await memory(name)).close();
	});

	it("keeps an exception a storage driver threw as the error's cause", async () => {
		const failure = new Error("disk on fire");
		const driver = new MemoryDriver();
		fakeFs(() => driver);
		const db = await sqlite.open(unique("fire"), { storage: "fs", journal: "delete" });
		driver.write = () => {
			throw failure;
		};
		const error = thrown(() => db.execute("create table t (x)"));
		expect(error).toMatchObject({ code: "SQLITE_IOERR_WRITE" });
		expect(error.cause).toBe(failure);
		db.close();
	});

	it("calls a driver's prepare and release hooks around open, attach, detach and close", async () => {
		const driver = new MemoryDriver();
		const events = [];
		driver.prepare = async (path, options) => {
			events.push(["prepare", path, options.create]);
			return `/prepared/${path}`;
		};
		driver.release = (name) => {
			events.push(["release", name]);
			// A failing asynchronous release must not surface as an unhandled rejection.
			return Promise.reject(new Error("release failed"));
		};
		const previous = install("opfs", async () => ({ create: () => driver }));
		restore.push(() => install("opfs", previous));

		const name = unique("hooked");
		const db = await sqlite.open(name, { storage: "opfs" });
		db.execute("create table t (x)");
		expect(db.info.path).toBe(name);
		expect(driver.files()).toContain(`/prepared/${name}`);
		const other = unique("hooked-other");
		await db.attach(other, "other");
		db.execute("create table other.u (y)");
		await db.detach("other");
		db.close();
		expect(events).toEqual([
			["prepare", name, true],
			["prepare", other, true],
			["release", `/prepared/${other}`],
			["release", `/prepared/${name}`]
		]);

		events.length = 0;
		const missing = unique("hooked-missing");
		expect(await rejected(sqlite.open(missing, { storage: "opfs", create: false }))).toMatchObject({ code: "SQLITE_CANTOPEN" });
		expect(events).toEqual([
			["prepare", missing, false],
			["release", `/prepared/${missing}`]
		]);

		// A prepared name that is already routed to another driver is refused and released.
		events.length = 0;
		const taken = await memory(`/prepared/${unique("taken")}`);
		const clash = taken.info.path.slice("/prepared/".length);
		expect(await rejected(sqlite.open(clash, { storage: "opfs" }))).toMatchObject({ code: "SQLITE_CANTOPEN" });
		expect(events).toEqual([
			["prepare", clash, true],
			["release", `/prepared/${clash}`]
		]);
		taken.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
