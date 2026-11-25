/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/worker/engine.test.vitest.mjs
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { afterEach, describe, expect, it } from "vitest";
import { open } from "../../src/worker/engine.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";
import { install } from "../../src/vfs/registry.mts";

let counter = 0;
const fresh = (options = {}) => open(`engine-${process.pid}-${++counter}.db`, { storage: "memory", ...options });

const restore = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
});

describe("engine", () => {
	it("runs statements in every shape through the public API", async () => {
		const db = await fresh();
		db.execute("create table t(id integer primary key, a, b); insert into t(a, b) values (1, 'x'), (2, 'y')");
		expect(db.statement("select a, b from t order by a", [], "object", false)).toEqual([
			{ a: 1, b: "x" },
			{ a: 2, b: "y" }
		]);
		expect(db.statement("select a, b from t where a = ?", [1], "object", true)).toEqual({ a: 1, b: "x" });
		expect(db.statement("select a, b from t order by a", [], "raw", false)).toEqual([
			[1, "x"],
			[2, "y"]
		]);
		expect(db.statement("select a, b from t where a = :a", { a: 2 }, "raw", true)).toEqual([2, "y"]);
		expect(db.statement("select a from t order by a", [], "pluck", false)).toEqual([1, 2]);
		expect(db.statement("select a, b, a + 1 as c from t where a = 1", [], "expand", true)).toEqual({ t: { a: 1, b: "x" }, $: { c: 2 } });
		expect(db.statement("select a from t where a > 5", [], "object", true)).toBeUndefined();
		expect(db.statement("insert into t(a, b) values (?, ?)", [3, true], "run", false)).toEqual({ changes: 1, rowid: 3 });
		expect(db.columns("select a, b as bee from t")).toEqual([
			{ name: "a", column: "a", table: "t", database: "main", type: null },
			{ name: "bee", column: "b", table: "t", database: "main", type: null }
		]);
		db.close();
	});

	it("evicts and closes the least recently used statement past the cache size", async () => {
		const db = await fresh();
		for (let index = 0; index < 70; index++) expect(db.statement(`select ${index} as v`, [], "pluck", true)).toBe(index);
		expect(db.statement("select 69 as v", [], "pluck", true)).toBe(69);
		expect(db.statement("select 0 as v", [], "pluck", true)).toBe(0);
		db.close();
	});

	it("tracks transactions, reports SQLite errors and closes", async () => {
		const db = await fresh();
		db.execute("create table t(a unique); insert into t values (1)");
		expect(() => db.statement("insert into t values (1)", [], "run", false)).toThrow(
			expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" })
		);
		expect(db.autocommit()).toBe(true);
		db.execute("begin");
		expect(db.autocommit()).toBe(false);
		db.close();
		expect(db.autocommit()).toBe(true);
		expect(db.db.info.open).toBe(false);
		expect(() => db.execute("select 1")).toThrow("database is closed");
	});

	it("applies sqlite.open()'s settings and hands extra options to the driver", async () => {
		const seen = [];
		const driver = new MemoryDriver();
		const previous = install("opfs", async () => ({ create: (options) => (seen.push(options), driver) }));
		restore.push(() => install("opfs", previous));
		const db = await open(`engine-opfs-${process.pid}.db`, { storage: "opfs", journal: "truncate" }, { root: "R", locks: null });
		expect(seen[0]).toMatchObject({ root: "R", locks: null, readonly: false, create: true });
		expect(db.statement("pragma journal_mode", [], "pluck", true)).toBe("truncate");
		expect(db.statement("pragma foreign_keys", [], "pluck", true)).toBe(1);
		db.close();
	});
});
