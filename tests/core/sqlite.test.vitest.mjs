/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/core/sqlite.test.vitest.mjs
 *	@Date: 2026-11-25T01:10:29-08:00 (1795597829)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:06-08:00 (1795598286)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openRaw } from "../../src/core/raw.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

const versions = JSON.parse(readFileSync(new URL("../../sqlite.version.json", import.meta.url), "utf8"));

/** Every compile option the design enables, as `PRAGMA compile_options` spells it. */
const ENABLED = [
	"ENABLE_FTS3",
	"ENABLE_FTS3_PARENTHESIS",
	"ENABLE_FTS5",
	"ENABLE_RTREE",
	"ENABLE_GEOPOLY",
	"ENABLE_DBSTAT_VTAB",
	"ENABLE_MATH_FUNCTIONS",
	"ENABLE_COLUMN_METADATA",
	"ENABLE_STAT4",
	"ENABLE_UPDATE_DELETE_LIMIT",
	"ENABLE_PERCENTILE",
	"DEFAULT_FOREIGN_KEYS",
	"DEFAULT_MEMSTATUS=0",
	"DQS=0",
	"TEMP_STORE=3",
	"DEFAULT_WAL_SYNCHRONOUS=1",
	"LIKE_DOESNT_MATCH_BLOBS",
	"THREADSAFE=0"
];

/** Features the design leaves out: each shows up as its OMIT_* option. */
const OMITTED = ["LOAD_EXTENSION", "UTF16", "SHARED_CACHE", "DEPRECATED", "PROGRESS_CALLBACK", "TCL_VARIABLE", "GET_TABLE"];

/** Options that must not be on (they would undo an omission or a default above). */
const MUST_NOT_HAVE = ["ENABLE_LOAD_EXTENSION", "ENABLE_SHARED_CACHE", "ENABLE_FTS4", "THREADSAFE=1", "THREADSAFE=2", "DQS=3"];

const open = [];
async function db(name = "test.db", driver = new MemoryDriver()) {
	const handle = await openRaw(name, { driver });
	open.push(handle);
	return handle;
}
afterEach(() => {
	for (const handle of open.splice(0)) handle.close();
});

describe("sqlite3.wasm", () => {
	it("reports the pinned SQLite version", async () => {
		const [row] = (await db()).exec("select sqlite_version() as v");
		expect(row.v).toBe(versions.sqlite.version);
	});

	it("was built with every enabled option and none of the excluded ones", async () => {
		const options = (await db()).exec("pragma compile_options").map((row) => row.compile_options);
		for (const option of ENABLED) expect(options).toContain(option);
		for (const feature of OMITTED) expect(options).toContain(`OMIT_${feature}`);
		for (const option of MUST_NOT_HAVE) expect(options).not.toContain(option);
	});

	it("leaves out extension loading", async () => {
		const handle = await db();
		expect(() => handle.exec("select load_extension('x')")).toThrow(/no such function: load_extension/);
	});

	it("runs FTS3 and FTS4 queries, including parenthesised boolean ones", async () => {
		const handle = await db();
		handle.exec(`
			create virtual table d3 using fts3(body);
			create virtual table d4 using fts4(title, body);
			insert into d3(body) values ('sqlite in wasm'), ('native sqlite'), ('wasm only');
			insert into d4(title, body) values ('one', 'alpha beta'), ('two', 'beta gamma');
		`);
		expect(handle.exec("select body from d3 where body match '(sqlite AND wasm) OR native' order by rowid")).toEqual([
			{ body: "sqlite in wasm" },
			{ body: "native sqlite" }
		]);
		expect(handle.exec("select title from d4 where d4 match 'beta NOT alpha'")).toEqual([{ title: "two" }]);
		expect(handle.exec("select count(*) as n from d4 where d4 match 'beta'")).toEqual([{ n: 2 }]);
	});

	it("runs FTS5 with ranking and highlight()", async () => {
		const handle = await db();
		handle.exec(
			"create virtual table d using fts5(body); insert into d(body) values ('the quick brown fox'), ('lazy dog'), ('quick quick');"
		);
		expect(handle.exec("select highlight(d, 0, '[', ']') as h from d where d match 'quick' order by rank")).toEqual([
			{ h: "[quick] [quick]" },
			{ h: "the [quick] brown fox" }
		]);
	});

	it("runs R*Tree range queries", async () => {
		const handle = await db();
		handle.exec(`
			create virtual table r using rtree(id, minX, maxX, minY, maxY);
			insert into r values (1, 0, 10, 0, 10), (2, 20, 30, 20, 30), (3, 5, 25, 5, 25);
		`);
		expect(handle.exec("select id from r where maxX >= 8 and minX <= 9 and maxY >= 8 and minY <= 9 order by id")).toEqual([
			{ id: 1 },
			{ id: 3 }
		]);
	});

	it("runs Geopoly containment queries", async () => {
		const handle = await db();
		handle.exec(`
			create virtual table g using geopoly(name);
			insert into g(_shape, name) values ('[[0,0],[10,0],[10,10],[0,10],[0,0]]', 'square'), ('[[20,20],[30,20],[25,30],[20,20]]', 'triangle');
		`);
		expect(handle.exec("select name from g where geopoly_contains_point(_shape, 5, 5)")).toEqual([{ name: "square" }]);
		expect(handle.exec("select geopoly_area(_shape) as a from g where name = 'square'")).toEqual([{ a: 100 }]);
	});

	it("exposes dbstat", async () => {
		const handle = await db();
		handle.exec("create table t(x); insert into t values (randomblob(5000));");
		const rows = handle.exec("select name, sum(pgsize) as bytes from dbstat group by name order by name");
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.name === "t").bytes).toBeGreaterThan(4096);
	});

	it("supports math, JSON and percentile", async () => {
		const handle = await db();
		expect(
			handle.exec(
				"select sqrt(16) as r, json_extract('{\"a\":[1,2]}', '$.a[1]') as j, median(x) as m from (select 1 as x union all select 5 union all select 9)"
			)
		).toEqual([{ r: 4, j: 2, m: 5 }]);
	});

	it("limits UPDATE by ORDER BY and LIMIT", async () => {
		const handle = await db();
		handle.exec("create table t(id integer primary key, v text); insert into t(id, v) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		const changed = () => handle.exec("select changes() as n")[0].n;
		handle.exec("update t set v = 'x' order by id desc limit 2");
		expect(changed()).toBe(2);
		expect(handle.exec("select id, v from t order by id")).toEqual([
			{ id: 1, v: "a" },
			{ id: 2, v: "b" },
			{ id: 3, v: "x" },
			{ id: 4, v: "x" }
		]);
		handle.exec("update t set v = 'y' where id < 4 order by id limit 1 offset 1");
		expect(changed()).toBe(1);
		expect(handle.exec("select v from t where id = 2")).toEqual([{ v: "y" }]);
	});

	it("limits DELETE by ORDER BY and LIMIT", async () => {
		const handle = await db();
		handle.exec("create table t(id integer primary key, v text); insert into t(id, v) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')");
		handle.exec("delete from t order by id desc limit 2");
		expect(handle.exec("select changes() as n")).toEqual([{ n: 2 }]);
		expect(handle.exec("select id from t order by id")).toEqual([{ id: 1 }, { id: 2 }]);
		handle.exec("delete from t where id > 0 limit 5");
		expect(handle.exec("select count(*) as n from t")).toEqual([{ n: 0 }]);
	});

	it("enforces foreign keys by default", async () => {
		const handle = await db();
		handle.exec("create table p(id integer primary key); create table c(p references p(id));");
		expect(() => handle.exec("insert into c values (1)")).toThrow(expect.objectContaining({ errcode: 787 }));
	});

	it("runs in WAL mode with exclusive locking on the memory driver", async () => {
		const driver = new MemoryDriver();
		const handle = await db("wal.db", driver);
		expect(handle.exec("pragma locking_mode = exclusive")).toEqual([{ locking_mode: "exclusive" }]);
		expect(handle.exec("pragma journal_mode = wal")).toEqual([{ journal_mode: "wal" }]);
		handle.exec("create table t(id integer primary key, v text); insert into t(v) values ('a'), ('b');");
		expect(driver.files()).toContain("wal.db-wal");
		expect(driver.contents("wal.db-wal").length).toBeGreaterThan(0);
		expect(handle.exec("select v from t order by id")).toEqual([{ v: "a" }, { v: "b" }]);
		expect(handle.exec("pragma wal_checkpoint(truncate)")[0].busy).toBe(0);
		expect(handle.exec("pragma integrity_check")).toEqual([{ integrity_check: "ok" }]);
		handle.close();
		// A clean close checkpoints and removes the WAL; the database file alone holds the data.
		expect(driver.files()).not.toContain("wal.db-wal");
		// The file stays in WAL mode. Without xShm* methods, reading it needs exclusive locking set first...
		const reopened = await db("wal.db", driver);
		expect(() => reopened.exec("select count(*) as n from t")).toThrow(expect.objectContaining({ errcode: 14 }));
		// ...and with it, the data is all there.
		expect(reopened.exec("pragma locking_mode = exclusive; select count(*) as n from t")).toEqual([{ n: 2 }]);
	});

	it("rolls a journal back and keeps the database consistent", async () => {
		const handle = await db("journal.db");
		handle.exec("pragma journal_mode = truncate; create table t(x unique); insert into t values (1);");
		expect(() => handle.exec("begin; insert into t values (2); insert into t values (1);")).toThrow(/UNIQUE constraint failed/);
		handle.exec("rollback");
		expect(handle.exec("select x from t")).toEqual([{ x: 1 }]);
		expect(handle.exec("pragma integrity_check")).toEqual([{ integrity_check: "ok" }]);
	});

	it("blocks a second writer while the first holds the database (SQLITE_BUSY)", async () => {
		const driver = new MemoryDriver();
		const first = await db("shared.db", driver);
		const second = await db("shared.db", driver);
		first.exec("create table t(x); insert into t values (1);");
		expect(second.exec("select x from t")).toEqual([{ x: 1 }]);
		first.exec("begin immediate; insert into t values (2);");
		expect(() => second.exec("insert into t values (3)")).toThrow(expect.objectContaining({ errcode: 5 }));
		first.exec("commit");
		second.exec("insert into t values (3)");
		expect(first.exec("select count(*) as n from t")).toEqual([{ n: 3 }]);
		expect(second.exec("select count(*) as n from t")).toEqual([{ n: 3 }]);
		// Exclusive locking mode keeps the EXCLUSIVE lock after a write; readers then get SQLITE_BUSY.
		first.exec("pragma locking_mode = exclusive; insert into t values (4);");
		expect(() => second.exec("select * from t")).toThrow(expect.objectContaining({ errcode: 5 }));
	});

	it("uses temp files in memory", async () => {
		const driver = new MemoryDriver();
		const handle = await db("temp.db", driver);
		handle.exec("create temp table scratch(x); insert into scratch values (1);");
		expect(handle.exec("select x from scratch")).toEqual([{ x: 1 }]);
		expect(driver.files()).toEqual(["temp.db"]);
	});

	it("reads the current time and random numbers through the VFS", async () => {
		const handle = await db();
		const [row] = handle.exec("select unixepoch() as now, typeof(random()) as r, length(randomblob(70000)) as n");
		expect(Math.abs(row.now - Date.now() / 1000)).toBeLessThan(5);
		expect(row.r).toBe("integer");
		expect(row.n).toBe(70000);
	});
});
