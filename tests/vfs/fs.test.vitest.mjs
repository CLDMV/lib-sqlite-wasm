/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/fs.test.vitest.mjs
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

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "../../src/vfs/fs.mts";
import { openRaw } from "../../src/core/raw.mts";
import { cleanup, open, scratch } from "./fs-helpers.mjs";

const READONLY = 0x1;
const READWRITE = 0x2;
const CREATE = 0x4;
const DELETE_ON_CLOSE = 0x8;
const EXCLUSIVE_OPEN = 0x10;
const MAIN_JOURNAL = 0x800;
const [NONE, SHARED, RESERVED, EXCLUSIVE] = [0, 1, 2, 4];
const [OK, BUSY, CANTOPEN, SHORT_READ, DELETE_NOENT] = [0, 5, 14, 522, 5898];
const [EXISTS, ACCESS_READWRITE, ACCESS_READ] = [0, 1, 2];

let nextId = 1_000_000;
const id = () => nextId++;

afterEach(cleanup);

describe("fs driver: files", () => {
	it("creates files only with SQLITE_OPEN_CREATE, and exclusively with SQLITE_OPEN_EXCLUSIVE", () => {
		const dir = scratch();
		const driver = create();
		const path = join(dir, "a.bin");
		expect(driver.open(path, id(), READWRITE)).toBe(CANTOPEN);
		const first = id();
		expect(driver.open(path, first, READWRITE | CREATE)).toBe(OK);
		expect(existsSync(path)).toBe(true);
		expect(() => driver.open(path, id(), READWRITE | CREATE | EXCLUSIVE_OPEN)).toThrow(/EEXIST/);
		const second = id();
		expect(driver.open(path, second, READONLY)).toBe(OK);
		expect(() => driver.write(second, new Uint8Array([1]), 0)).toThrow(/EBADF/);
		expect(driver.close(first)).toBe(OK);
		expect(driver.close(second)).toBe(OK);
		// Opening a directory as a file is an I/O error, not "missing".
		expect(() => driver.open(dir, id(), READWRITE)).toThrow(/EISDIR/);
	});

	it("reads, writes, truncates, syncs and zero-fills short reads", () => {
		const dir = scratch();
		const driver = create({ timeout: 0 });
		const file = id();
		expect(driver.open(join(dir, "f"), file, READWRITE | CREATE | MAIN_JOURNAL)).toBe(OK);
		expect(driver.write(file, new Uint8Array([1, 2, 3]), 0)).toBe(OK);
		expect(driver.write(file, new Uint8Array([9]), 10)).toBe(OK);
		expect(driver.size(file)).toBe(11);
		expect(readFileSync(join(dir, "f"))).toEqual(Buffer.from([1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 9]));

		const target = new Uint8Array(4).fill(0xee);
		expect(driver.read(file, target, 9)).toBe(SHORT_READ);
		expect(target).toEqual(new Uint8Array([0, 9, 0, 0]));
		target.fill(0xee);
		expect(driver.read(file, target, 100)).toBe(SHORT_READ);
		expect(target).toEqual(new Uint8Array(4));
		expect(driver.read(file, target, 0)).toBe(OK);
		expect(target).toEqual(new Uint8Array([1, 2, 3, 0]));

		expect(driver.truncate(file, 2)).toBe(OK);
		expect(driver.size(file)).toBe(2);
		expect(driver.sync(file, 0x2)).toBe(OK);
		expect(driver.sync(file, 0x3 | 0x10)).toBe(OK);
		expect(driver.sectorSize(file)).toBe(4096);
		expect(driver.deviceCharacteristics(file)).toBe(0x1000);
		expect(driver.close(file)).toBe(OK);
		expect(() => driver.size(file)).toThrow(/no open file with id/);
	});

	it("names temporary files itself and deletes them on close, like DELETEONCLOSE files", () => {
		const dir = scratch();
		const driver = create();
		const temp = id();
		expect(driver.open(null, temp, READWRITE | CREATE | DELETE_ON_CLOSE)).toBe(OK);
		expect(driver.write(temp, new Uint8Array(10), 0)).toBe(OK);
		expect(driver.size(temp)).toBe(10);
		expect(driver.close(temp)).toBe(OK);

		const named = id();
		const path = join(dir, "scratch");
		expect(driver.open(path, named, READWRITE | CREATE | DELETE_ON_CLOSE)).toBe(OK);
		expect(existsSync(path)).toBe(true);
		expect(driver.close(named)).toBe(OK);
		expect(existsSync(path)).toBe(false);
	});

	it("deletes files and reports missing ones", () => {
		const dir = scratch();
		const driver = create();
		const path = join(dir, "gone");
		writeFileSync(path, "x");
		expect(driver.delete(path, true)).toBe(OK);
		expect(existsSync(path)).toBe(false);
		expect(driver.delete(path, false)).toBe(DELETE_NOENT);
		mkdirSync(join(dir, "folder"));
		expect(() => driver.delete(join(dir, "folder"), false)).toThrow(/EISDIR|EPERM/);
	});

	it("answers access checks like SQLite's unix VFS", () => {
		const dir = scratch();
		const driver = create();
		const empty = join(dir, "empty");
		const full = join(dir, "full");
		const locked = join(dir, "locked");
		writeFileSync(empty, "");
		writeFileSync(full, "data");
		writeFileSync(locked, "data");
		chmodSync(locked, 0o444);
		expect(driver.access(join(dir, "missing"), EXISTS)).toBe(false);
		expect(driver.access(empty, EXISTS)).toBe(false); // an empty file isn't a hot journal
		expect(driver.access(full, EXISTS)).toBe(true);
		expect(driver.access(dir, EXISTS)).toBe(true);
		expect(driver.access(full, ACCESS_READWRITE)).toBe(true);
		expect(driver.access(locked, ACCESS_READ)).toBe(true);
		expect(driver.access(locked, ACCESS_READWRITE)).toBe(process.getuid?.() === 0);
		expect(driver.access(join(dir, "missing"), ACCESS_READ)).toBe(false);
		expect(driver.fullPathname("rel/x.db")).toBe(resolve("rel/x.db"));
	});

	it("tracks lock levels across handles and driver objects in one process", () => {
		const dir = scratch();
		const path = join(dir, "locks");
		const [one, two] = [create(), create()];
		const [a, b] = [id(), id()];
		one.open(path, a, READWRITE | CREATE);
		two.open(path, b, READWRITE);
		expect(one.lock(a, SHARED)).toBe(OK);
		expect(two.lock(b, SHARED)).toBe(OK);
		expect(one.lock(a, RESERVED)).toBe(OK);
		expect(two.checkReserved(b)).toBe(true);
		expect(one.checkReserved(a)).toBe(false);
		expect(two.lock(b, RESERVED)).toBe(BUSY);
		expect(one.lock(a, EXCLUSIVE)).toBe(BUSY); // b still holds SHARED; a waits at PENDING
		expect(two.unlock(b, NONE)).toBe(OK);
		expect(two.lock(b, SHARED)).toBe(BUSY); // PENDING keeps new readers out
		expect(two.lock(b, RESERVED)).toBe(BUSY);
		expect(one.lock(a, EXCLUSIVE)).toBe(OK);
		expect(one.unlock(a, SHARED)).toBe(OK);
		expect(two.lock(b, SHARED)).toBe(OK);
		expect(two.close(b)).toBe(OK);
		expect(one.close(a)).toBe(OK);
	});
});

describe("fs driver: databases", () => {
	it("creates, writes, reopens and reads a database (WAL by default)", async () => {
		const dir = scratch();
		const path = join(dir, "app.db");
		const db = await open(path);
		expect(db.exec("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)");
		db.exec("INSERT INTO t (name, data) VALUES ('a', x'0102'), ('b', NULL)");
		expect(existsSync(`${path}-wal`)).toBe(true);
		expect(existsSync(`${path}.lock/owner.json`)).toBe(true);
		db.close();
		// A clean close checkpoints and removes the WAL, and releases the owner lock.
		expect(readdirSync(dir)).toEqual(["app.db"]);
		expect(readFileSync(path)[18]).toBe(2); // the header still says WAL

		const again = await open(path);
		expect(again.exec("SELECT name, data FROM t ORDER BY id")).toEqual([
			{ name: "a", data: new Uint8Array([1, 2]) },
			{ name: "b", data: null }
		]);
		expect(again.exec("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
		again.close();
	});

	it("can't reopen a WAL file without exclusive locking (no shared memory)", async () => {
		const dir = scratch();
		const path = join(dir, "wal.db");
		const db = await open(path);
		db.exec("CREATE TABLE t (x)");
		db.close();
		const plain = await openRaw(path, { driver: create() });
		expect(() => plain.exec("SELECT * FROM t")).toThrow();
		plain.close();
	});

	for (const journal of ["truncate", "delete"]) {
		it(`works in ${journal} journal mode`, async () => {
			const dir = scratch();
			const path = join(dir, `${journal}.db`);
			const db = await open(path, { journal });
			expect(db.exec("PRAGMA journal_mode")).toEqual([{ journal_mode: journal }]);
			db.exec("CREATE TABLE t (x); BEGIN; INSERT INTO t VALUES (1), (2);");
			expect(statSync(`${path}-journal`).size).toBeGreaterThan(0);
			db.exec("COMMIT");
			if (journal === "delete") expect(existsSync(`${path}-journal`)).toBe(false);
			else expect(statSync(`${path}-journal`).size).toBe(0);
			db.exec("BEGIN; INSERT INTO t VALUES (3); ROLLBACK;");
			db.close();

			const again = await open(path, { journal });
			expect(again.exec("SELECT x FROM t ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }]);
			again.close();
		});
	}

	it("opens read-only", async () => {
		const dir = scratch();
		const path = join(dir, "ro.db");
		const db = await open(path, { journal: "delete" });
		db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
		db.close();
		const ro = await openRaw(path, { driver: create(), flags: READONLY });
		expect(ro.exec("SELECT x FROM t")).toEqual([{ x: 1 }]);
		expect(() => ro.exec("INSERT INTO t VALUES (2)")).toThrow(/readonly/);
		ro.close();
	});

	it("lets a second connection in the same process share the owner lock but not the database", async () => {
		const dir = scratch();
		const path = join(dir, "shared.db");
		const first = await open(path);
		first.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
		// Rollback mode on the second connection so it doesn't need the WAL index the first one keeps in its own heap.
		const second = await openRaw(path, { driver: create() });
		expect(() => second.exec("SELECT * FROM t")).toThrow(/locked/);
		first.close();
		expect(existsSync(`${path}.lock`)).toBe(true); // still held by the second connection
		second.exec("PRAGMA locking_mode = EXCLUSIVE");
		expect(second.exec("SELECT x FROM t")).toEqual([{ x: 1 }]);
		second.close();
		expect(existsSync(`${path}.lock`)).toBe(false);
	});
});
