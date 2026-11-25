/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/fs-lock.test.vitest.mjs
 *	@Date: 2026-11-25T01:49:24-08:00 (1795600164)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:21:02-08:00 (1795634462)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { child, cleanup, open, plantLock, scratch } from "./fs-helpers.mjs";

const READWRITE_CREATE_MAIN = 0x2 | 0x4 | 0x100;
const [OK, BUSY] = [0, 5];

let nextId = 2_000_000;
const id = () => nextId++;

/** The owner recorded in `<db>.lock/owner.json`. */
const ownerOf = (path) => JSON.parse(readFileSync(`${path}.lock/owner.json`, "utf8"));

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

describe("owner lock: in process", () => {
	// First in the file: a fresh module instance, so the exit handler is registered while we watch.
	it("registers one exit handler that releases every lock still held", async () => {
		vi.resetModules();
		const on = vi.spyOn(process, "on");
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const driver = create();
		const [a, b] = [id(), id()];
		expect(driver.open(join(dir, "a.db"), a, READWRITE_CREATE_MAIN)).toBe(OK);
		expect(driver.open(join(dir, "b.db"), b, READWRITE_CREATE_MAIN)).toBe(OK);
		const exits = on.mock.calls.filter(([event]) => event === "exit");
		expect(exits).toHaveLength(1);
		on.mockRestore();
		process.off("exit", exits[0][1]);
		exits[0][1]();
		expect(existsSync(join(dir, "a.db.lock"))).toBe(false);
		expect(existsSync(join(dir, "b.db.lock"))).toBe(false);
		// Closing after the handler ran is harmless.
		expect(driver.close(a)).toBe(OK);
		expect(driver.close(b)).toBe(OK);
	});

	it("writes the owner record and counts references within the process", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		const driver = create();
		const [a, b] = [id(), id()];
		expect(driver.open(path, a, READWRITE_CREATE_MAIN)).toBe(OK);
		expect(driver.open(path, b, READWRITE_CREATE_MAIN)).toBe(OK);
		expect(ownerOf(path)).toMatchObject({ pid: process.pid, hostname: expect.any(String), started: expect.any(String) });
		expect(readdirSync(dir).sort()).toEqual(["db", "db.lock"]);
		driver.close(a);
		expect(existsSync(`${path}.lock`)).toBe(true);
		driver.close(b);
		expect(readdirSync(dir)).toEqual(["db"]);
	});

	it("leaves a lock directory alone at close once it belongs to someone else", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		const driver = create();
		const a = id();
		driver.open(path, a, READWRITE_CREATE_MAIN);
		writeFileSync(`${path}.lock/owner.json`, JSON.stringify({ pid: 1, hostname: "elsewhere", started: "x" }));
		driver.close(a);
		expect(ownerOf(path).hostname).toBe("elsewhere");
	});

	it("fails with SQLITE_BUSY after the timeout while a live owner holds the lock", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		plantLock(`${path}.lock`, { hostname: "another-host" });
		expect(create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toBe(BUSY);
		const started = Date.now();
		expect(create({ timeout: 120 }).open(path, id(), READWRITE_CREATE_MAIN)).toBe(BUSY);
		expect(Date.now() - started).toBeGreaterThanOrEqual(110);
		// Our own pid is alive too.
		plantLock(`${path}.lock`, { pid: process.pid });
		expect(create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toBe(BUSY);
		// The file was opened and closed again; no stray temporary directories are left.
		expect(readdirSync(dir).sort()).toEqual(["db", "db.lock"]);
	});

	it("treats an owner whose process belongs to another user (EPERM) as live", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		const owner = plantLock(`${path}.lock`);
		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid !== owner.pid) return true;
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		expect(create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toBe(BUSY);
	});

	it("takes over a lock whose owner is dead on this host", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		plantLock(`${path}.lock`);
		const driver = create({ timeout: 0 });
		const a = id();
		expect(driver.open(path, a, READWRITE_CREATE_MAIN)).toBe(OK);
		expect(ownerOf(path).pid).toBe(process.pid);
		driver.close(a);
		expect(readdirSync(dir)).toEqual(["db"]);
	});

	it("takes over a lock with a missing or malformed owner record", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const records = [
			"not json",
			JSON.stringify({ pid: "1", hostname: "h", started: "s" }),
			JSON.stringify({ pid: -1, hostname: "h", started: "s" }),
			JSON.stringify({ pid: 1, hostname: 5, started: "s" }),
			JSON.stringify({ pid: 1, hostname: "h", started: 5 })
		];
		for (const record of records) {
			const dir = scratch();
			const path = join(dir, "db");
			plantLock(`${path}.lock`, record);
			const driver = create({ timeout: 0 });
			const a = id();
			expect(driver.open(path, a, READWRITE_CREATE_MAIN)).toBe(OK);
			expect(ownerOf(path).pid).toBe(process.pid);
			driver.close(a);
		}
		// An empty lock directory (no owner file at all) is simply replaced.
		const dir = scratch();
		const path = join(dir, "db");
		mkdirSync(`${path}.lock`);
		const driver = create({ timeout: 0 });
		const a = id();
		expect(driver.open(path, a, READWRITE_CREATE_MAIN)).toBe(OK);
		driver.close(a);
	});

	it("clears a takeover abandoned by a dead process, and waits for a live one", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		plantLock(`${path}.lock`);
		plantLock(`${path}.lock/reap`);
		plantLock(`${path}.lock/reap/reap`);
		const driver = create({ timeout: 0 });
		const a = id();
		expect(driver.open(path, a, READWRITE_CREATE_MAIN)).toBe(OK);
		expect(readdirSync(`${path}.lock`)).toEqual(["owner.json"]);
		driver.close(a);

		plantLock(`${path}.lock`);
		plantLock(`${path}.lock/reap`, { hostname: "another-host" });
		expect(create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toBe(BUSY);
	});

	it("fails the open when the lock path can't be created", async () => {
		const { create } = await import("../../src/vfs/fs.mts");
		const dir = scratch();
		const path = join(dir, "db");
		writeFileSync(`${path}.lock`, "a file, not a directory");
		expect(() => create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toThrow(/ENOTDIR|EISDIR/);
		expect(readdirSync(dir).sort()).toEqual(["db", "db.lock"]);
	});
});

describe("owner lock: between processes", () => {
	it("gives the second process SQLITE_BUSY after the timeout, and lets it in once the first closes", async () => {
		const dir = scratch();
		const path = join(dir, "two.db");
		const holder = child("hold", path);
		expect(await holder.next()).toBe("open");
		expect(ownerOf(path).pid).toBe(holder.proc.pid);

		const started = Date.now();
		await expect(open(path, { timeout: 300 })).rejects.toMatchObject({ errcode: BUSY });
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);

		holder.send("close");
		expect(await holder.next()).toBe("closed");
		await holder.exited;
		const db = await open(path, { timeout: 0 });
		expect(db.exec("SELECT x FROM t")).toEqual([{ x: "child" }]);
		db.close();
	});

	it("waits for the first process to close when the timeout allows it", async () => {
		const dir = scratch();
		const path = join(dir, "wait.db");
		const holder = child("hold", path, 400);
		expect(await holder.next()).toBe("open");
		const db = await open(path, { timeout: 15000 });
		expect(db.exec("SELECT x FROM t")).toEqual([{ x: "child" }]);
		db.close();
		await holder.exited;
	});

	it("takes over the lock of a process that was SIGKILLed", async () => {
		const dir = scratch();
		const path = join(dir, "killed.db");
		const holder = child("hold", path);
		expect(await holder.next()).toBe("open");
		holder.proc.kill("SIGKILL");
		expect(await holder.exited).toMatchObject({ signal: "SIGKILL" });
		expect(ownerOf(path).pid).toBe(holder.proc.pid);

		const db = await open(path, { timeout: 0 });
		expect(ownerOf(path).pid).toBe(process.pid);
		expect(db.exec("SELECT x FROM t")).toEqual([{ x: "child" }]);
		expect(db.exec("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
		db.close();
		expect(readdirSync(dir)).toEqual(["killed.db"]);
	});

	it("releases the lock when a process exits without closing", async () => {
		const dir = scratch();
		const path = join(dir, "exit.db");
		const holder = child("exit", path);
		expect(await holder.next()).toBe("open");
		expect(await holder.exited).toMatchObject({ code: 0 });
		expect(existsSync(`${path}.lock`)).toBe(false);
	});
});
