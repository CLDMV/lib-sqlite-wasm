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

import { describe, expect, it } from "vitest";
import { open } from "../../src/worker/engine.mts";
import { loadSqliteModule } from "../../src/core/loader.mts";
import { RawSqliteError } from "../../src/core/raw.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

const module = await loadSqliteModule();
const fresh = (name = "test.db", options = {}) => open(name, { module, driver: new MemoryDriver(), ...options });

describe("engine", () => {
	it("binds every value type and reads every column type", async () => {
		const db = await fresh();
		const row = db.statement(
			"select ? as i, ? as big, ? as f, ? as t, ? as empty, ? as b, ? as nil, ? as n, ? as u, ? as yes, ? as no",
			[42, 9007199254740993n, 1.5, "héllo\0x", "", new Uint8Array([0, 255]), new Uint8Array(0), null, undefined, true, false],
			"object",
			true
		);
		expect(row).toEqual({
			i: 42,
			big: 9007199254740993n,
			f: 1.5,
			t: "héllo\0x",
			empty: "",
			b: new Uint8Array([0, 255]),
			nil: new Uint8Array(0),
			n: null,
			u: null,
			yes: 1,
			no: 0
		});
		expect(db.statement("select typeof(?) as a, typeof(?) as b", ["", new Uint8Array(0)], "raw", true)).toEqual(["text", "blob"]);
		expect(db.statement("select ? as x", [2 ** 60], "pluck", true)).toBe(2 ** 60);
		db.close();
	});

	it("binds named parameters with any prefix and checks them", async () => {
		const db = await fresh();
		expect(db.statement("select :a + @b + $c as s", { a: 1, b: 2, c: 3 }, "pluck", true)).toBe(6);
		expect(() => db.statement("select :a as a", { b: 1 }, "pluck", true)).toThrow(/missing named parameter :a/);
		expect(() => db.statement("select ?1 as a", {}, "pluck", true)).toThrow(/missing named parameter \?1/);
		expect(() => db.statement("select ? as a", { a: 1 }, "pluck", true)).toThrow(/missing named parameter \?1/);
		expect(() => db.statement("select ? as a, ? as b", [1], "raw", true)).toThrow(/takes 2 parameter\(s\), 1 given/);
		expect(() => db.statement("select ? as a", [2n ** 64n], "raw", true)).toThrow(RangeError);
		expect(() => db.statement("select ? as a", [-(2n ** 64n)], "raw", true)).toThrow(RangeError);
		expect(() => db.statement("select ? as a", [{}], "raw", true)).toThrow(/cannot bind a value of type object/);
		// A failed bind leaves the cached statement reusable.
		expect(db.statement("select ? as a", [7], "pluck", true)).toBe(7);
		db.close();
	});

	it("returns rows in every shape", async () => {
		const db = await fresh();
		db.execute("create table t(a, b); insert into t values (1, 'x'), (2, 'y')");
		expect(db.statement("select a, b from t order by a", [], "object", false)).toEqual([
			{ a: 1, b: "x" },
			{ a: 2, b: "y" }
		]);
		expect(db.statement("select a, b from t order by a", [], "raw", false)).toEqual([
			[1, "x"],
			[2, "y"]
		]);
		expect(db.statement("select a from t order by a", [], "pluck", false)).toEqual([1, 2]);
		expect(db.statement("select a, b, a + 1 as c from t where a = 1", [], "expand", true)).toEqual({ t: { a: 1, b: "x" }, $: { c: 2 } });
		expect(db.statement("select a from t where a > 5", [], "object", true)).toBeUndefined();
		expect(db.statement("create table u(x)", [], "raw", false)).toEqual([]);
		db.close();
	});

	it("reports changes and the last rowid, as bigint when it is large", async () => {
		const db = await fresh();
		db.execute("create table t(id integer primary key, a)");
		expect(db.statement("insert into t(a) values (?), (?)", [1, 2], "run", false)).toEqual({ changes: 2, rowid: 2 });
		expect(db.statement("insert into t(id, a) values (?, 3) returning id", [2n ** 62n], "run", false)).toEqual({
			changes: 1,
			rowid: 2n ** 62n
		});
		db.close();
	});

	it("describes columns", async () => {
		const db = await fresh();
		db.execute("create table t(a integer, b text)");
		expect(db.columns("select a, b as bee, 1 as one from t")).toEqual([
			{ name: "a", column: "a", table: "t", database: "main", type: "INTEGER" },
			{ name: "bee", column: "b", table: "t", database: "main", type: "TEXT" },
			{ name: "one", column: null, table: null, database: null, type: null }
		]);
		db.close();
	});

	it("evicts the least recently used statement past the cache size", async () => {
		const db = await fresh();
		for (let index = 0; index < 70; index++) expect(db.statement(`select ${index} as v`, [], "pluck", true)).toBe(index);
		expect(db.statement("select 69 as v", [], "pluck", true)).toBe(69);
		expect(db.statement("select 0 as v", [], "pluck", true)).toBe(0);
		db.close();
	});

	it("turns failures into SQLite errors", async () => {
		const db = await fresh();
		db.execute("create table t(a unique); insert into t values (1); -- done");
		expect(() => db.statement("insert into t values (1)", [], "run", false)).toThrow(expect.objectContaining({ errcode: 2067 }));
		expect(() => db.execute("insert into t values (1)")).toThrow(RawSqliteError);
		expect(() => db.statement("selec 1", [], "raw", false)).toThrow(/syntax error/);
		expect(() => db.statement("   ", [], "raw", false)).toThrow(/contains no statement/);
		expect(db.autocommit()).toBe(true);
		db.execute("begin");
		expect(db.autocommit()).toBe(false);
		db.close();
		expect(db.autocommit()).toBe(false);
		db.close();
		expect(() => db.execute("select 1")).toThrow("database is closed");
		expect(() => db.statement("select 1", [], "raw", false)).toThrow("database is closed");
		expect(() => db.columns("select 1")).toThrow("database is closed");
	});

	it("opens read-only and without create, and keeps a driver failure as the cause", async () => {
		const driver = new MemoryDriver();
		await expect(open("missing.db", { module, driver, readonly: true })).rejects.toMatchObject({ errcode: 14 });
		await expect(open("missing.db", { module, driver, create: false })).rejects.toMatchObject({ errcode: 14 });

		const broken = new MemoryDriver();
		broken.open = () => {
			throw new Error("disk on fire");
		};
		const error = await open("x.db", { module, driver: broken }).catch((thrown) => thrown);
		expect(error.cause.message).toBe("disk on fire");

		// The cause is attached once, not to every later error.
		const flaky = new MemoryDriver();
		const db = await open("y.db", { module, driver: flaky });
		db.execute("create table t(a)");
		flaky.write = () => {
			throw new Error("write failed");
		};
		const first = (() => {
			try {
				db.execute("insert into t values (randomblob(100000))");
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(first.cause?.message).toBe("write failed");
		const second = (() => {
			try {
				db.execute("selec");
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(second.cause).toBeUndefined();
		db.close();
	});
});
