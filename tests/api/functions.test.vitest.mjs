/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/api/functions.test.vitest.mjs
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

import { describe, expect, it } from "vitest";
import { connection, memory, thrown } from "./helpers.mjs";

describe("db.fn.scalar", () => {
	it("calls the callback with converted arguments and stores its result", async () => {
		const db = await memory();
		db.fn.scalar("plus", (a, b) => a + b);
		expect(db.prepare("select plus(2, 3) as v").get()).toEqual({ v: 5 });
		db.fn.scalar("echo", (value) => value);
		const echo = db.prepare("select echo(?) as v, typeof(echo(?1)) as t");
		for (const [input, output, type] of [
			[null, null, "null"],
			[7, 7, "integer"],
			[2.5, 2.5, "real"],
			["a\0b", "a\0b", "text"],
			[new Uint8Array([1, 2]), new Uint8Array([1, 2]), "blob"],
			[new Uint8Array(0), new Uint8Array(0), "blob"],
			[2n ** 62n, 2n ** 62n, "integer"]
		]) {
			expect(echo.get(input)).toEqual({ v: output, t: type });
		}
		db.fn.scalar("constant", () => true);
		expect(db.prepare("select constant() as v").pluck.get()).toBe(1);
		db.fn.scalar("absent", () => undefined);
		expect(db.prepare("select absent() as v").pluck.get()).toBeNull();
		db.fn.scalar("huge", () => 2 ** 60);
		expect(db.prepare("select typeof(huge())").pluck.get()).toBe("real");
		db.close();
	});

	it("takes its argument count from the callback unless variadic", async () => {
		const db = await memory();
		db.fn.scalar("two", (a, b) => `${a}${b}`);
		expect(() => db.prepare("select two(1)")).toThrow(/wrong number of arguments/);
		db.fn.scalar("count_args", (...values) => values.length, { variadic: true });
		expect(db.prepare("select count_args(), count_args(1, 2, 3)").raw.get()).toEqual([0, 3]);
		db.close();
	});

	it("passes bigint arguments when asked", async () => {
		const db = await memory();
		db.fn.scalar("kind", (value) => typeof value);
		db.fn.scalar("bigkind", (value) => typeof value, { bigint: true });
		expect(db.prepare("select kind(1), bigkind(1)").raw.get()).toEqual(["number", "bigint"]);
		const big = await memory(undefined, { bigint: true });
		big.fn.scalar("kind", (value) => typeof value);
		expect(big.prepare("select kind(1)").pluck.get()).toBe("bigint");
		big.close();
		db.close();
	});

	it("marks deterministic functions so SQLite accepts them in indexes", async () => {
		const db = await memory();
		db.execute("create table t (x)");
		db.fn.scalar("loose", (x) => x);
		expect(() => db.execute("create index i on t (loose(x))")).toThrow(/non-deterministic functions prohibited/);
		db.fn.scalar("strict", (x) => x, { deterministic: true });
		db.execute("create index i on t (strict(x))");
		db.close();
	});

	it("rethrows what the callback throws, and rejects bad return values", async () => {
		const db = await memory();
		const failure = new Error("callback failed");
		db.fn.scalar("fail", () => {
			throw failure;
		});
		expect(thrown(() => db.prepare("select fail()").get())).toBe(failure);
		db.fn.scalar("failtext", () => {
			throw "plain string";
		});
		expect(thrown(() => db.execute("select failtext()"))).toBe("plain string");
		db.fn.scalar("date", () => new Date());
		expect(() => db.prepare("select date()").get()).toThrow(/cannot store a Date/);
		// The connection is fine afterwards.
		expect(db.prepare("select 1").pluck.get()).toBe(1);
		db.close();
	});

	it("can run queries from inside the callback", async () => {
		const db = await memory();
		db.execute("create table t (x); insert into t values (10)");
		const inner = db.prepare("select x from t");
		db.fn.scalar("lookup", () => inner.pluck.get());
		expect(db.prepare("select lookup() + 1").pluck.get()).toBe(11);
		db.close();
	});

	it("validates its arguments and reports registration failures", async () => {
		const db = await memory();
		expect(() => db.fn.scalar("", () => 1)).toThrow(/non-empty string/);
		expect(() => db.fn.scalar(5, () => 1)).toThrow(/non-empty string/);
		expect(() => db.fn.scalar("f", "not a function")).toThrow(/the callback must be a function/);
		const callbacks = connection(db).runtime.instance.callbacks;
		const before = callbacks.size;
		expect(thrown(() => db.fn.scalar("x".repeat(300), () => 1))).toMatchObject({
			code: "SQLITE_MISUSE",
			message: "bad parameter or other API misuse"
		});
		expect(callbacks.size).toBe(before);
		// Replacing a function while a statement using it is running is refused.
		db.fn.scalar("busy", () => 1);
		const running = db.prepare("select busy() from (select 1 union all select 2)").iterate();
		running.next();
		expect(thrown(() => db.fn.scalar("busy", () => 2))).toMatchObject({
			code: "SQLITE_BUSY",
			message: expect.stringMatching(/active statements/)
		});
		running.return();
		db.close();
		expect(() => db.fn.scalar("late", () => 1)).toThrow(/database is closed/);
	});

	it("forgets callbacks when functions are replaced or the database closes", async () => {
		const db = await memory();
		const callbacks = connection(db).runtime.instance.callbacks;
		const before = callbacks.size;
		db.fn.scalar("f", () => 1);
		db.fn.scalar("f", () => 2);
		expect(callbacks.size).toBe(before + 1);
		expect(db.prepare("select f()").pluck.get()).toBe(2);
		db.close();
		expect(callbacks.size).toBe(before);
	});
});

describe("db.fn.aggregate", () => {
	async function numbers() {
		const db = await memory();
		db.execute("create table n (g, x); insert into n values ('a', 1), ('a', 2), ('b', 3), ('a', 4), ('b', 5)");
		return db;
	}

	it("folds rows per group", async () => {
		const db = await numbers();
		expect(db.fn.agg).toBe(db.fn.aggregate);
		db.fn.aggregate("total", { start: 0, step: (total, x) => total + x });
		expect(db.prepare("select g, total(x) as t from n group by g order by g").raw.all()).toEqual([
			["a", 7],
			["b", 8]
		]);
		db.fn.agg("listed", { start: () => [], step: (list, x) => void list.push(x), result: (list) => list.join(",") });
		expect(db.prepare("select listed(x) from n where g = 'b'").pluck.get()).toBe("3,5");
		expect(db.prepare("select listed(x) from n where g = 'a'").pluck.get()).toBe("1,2,4");
		db.close();
	});

	it("returns the start value for an empty group", async () => {
		const db = await numbers();
		db.fn.aggregate("total", { start: 100, step: (total, x) => total + x });
		db.fn.aggregate("nulls", { step: (total, ___x) => total });
		db.fn.aggregate("fresh", { start: () => ["new"], step: (list, ___x) => list, result: (list) => list.length });
		expect(db.prepare("select total(x), nulls(x), fresh(x) from n where 0").raw.get()).toEqual([100, null, 1]);
		db.close();
	});

	it("works as a window function when it has an inverse", async () => {
		const db = await numbers();
		db.fn.aggregate("moving", { start: 0, step: (total, x) => total + x, inverse: (total, x) => total - x });
		expect(
			db.prepare("select x, moving(x) over (order by x rows between 1 preceding and current row) from n order by x").raw.all()
		).toEqual([
			[1, 1],
			[2, 3],
			[3, 5],
			[4, 7],
			[5, 9]
		]);
		db.close();
	});

	it("supports variadic and bigint aggregates", async () => {
		const db = await numbers();
		db.fn.aggregate("args", { start: 0, step: (total, ...values) => total + values.length, variadic: true });
		expect(db.prepare("select args(x, x, x) from n").pluck.get()).toBe(15);
		db.fn.aggregate("kinds", { start: "", step: (kinds, x) => kinds + typeof x, bigint: true, deterministic: true });
		expect(db.prepare("select kinds(x) from n where x < 3").pluck.get()).toBe("bigintbigint");
		db.close();
	});

	it("rethrows exceptions from start, step, inverse and result", async () => {
		const db = await numbers();
		const failure = new Error("aggregate failed");
		const fail = () => {
			throw failure;
		};
		db.fn.aggregate("badstart", { start: fail, step: (total, ___x) => total });
		db.fn.aggregate("badstep", { step: (___total, ___x) => fail() });
		db.fn.aggregate("badresult", { step: (___total, ___x) => 1, result: fail });
		db.fn.aggregate("badinverse", { start: 0, step: (total, x) => total + x, inverse: fail });
		expect(thrown(() => db.prepare("select badstart(x) from n").get())).toBe(failure);
		expect(thrown(() => db.prepare("select badstart(x) from n where 0").get())).toBe(failure);
		expect(thrown(() => db.prepare("select badstep(x) from n").get())).toBe(failure);
		expect(thrown(() => db.prepare("select badresult(x) from n").get())).toBe(failure);
		expect(thrown(() => db.prepare("select badinverse(x) over (order by x rows 1 preceding) from n").all())).toBe(failure);
		expect(db.prepare("select count(*) from n").pluck.get()).toBe(5);
		db.close();
	});

	it("validates the definition", async () => {
		const db = await memory();
		expect(() => db.fn.aggregate("", { step: () => 1 })).toThrow(/non-empty/);
		expect(() => db.fn.aggregate("a", {})).toThrow(/step must be a function/);
		expect(() => db.fn.aggregate("a", { step: () => 1, inverse: 1 })).toThrow(/inverse must be a function/);
		expect(() => db.fn.aggregate("a", { step: () => 1, result: 1 })).toThrow(/result must be a function/);
		db.close();
	});
});

describe("db.fn.collation", () => {
	it("orders and compares with the callback", async () => {
		const db = await memory();
		db.execute("create table w (s); insert into w values ('b'), ('A'), ('c'), ('a')");
		db.fn.collation("folded", (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		expect(db.prepare("select s from w order by s collate folded, s").pluck.all()).toEqual(["A", "a", "b", "c"]);
		expect(db.prepare("select 'X' = 'x' collate folded").pluck.get()).toBe(1);
		db.fn.collation("reverse", (a, b) => (a < b ? 1 : a > b ? -1 : 0));
		expect(db.prepare("select s from w order by s collate reverse").pluck.all()).toEqual(["c", "b", "a", "A"]);
		db.fn.collation("odd", () => "not a number");
		expect(db.prepare("select 'a' = 'b' collate odd").pluck.get()).toBe(1);
		db.close();
	});

	it("rethrows what the compare callback throws", async () => {
		const db = await memory();
		const failure = new Error("compare failed");
		db.fn.collation("broken", () => {
			throw failure;
		});
		expect(thrown(() => db.prepare("select 'a' < 'b' collate broken").get())).toBe(failure);
		db.close();
	});

	it("validates arguments and reports registration failures", async () => {
		const db = await memory();
		expect(() => db.fn.collation("", () => 0)).toThrow(/non-empty/);
		expect(() => db.fn.collation("c", null)).toThrow(/compare must be a function/);
		const callbacks = connection(db).runtime.instance.callbacks;
		db.execute("create table w (s); insert into w values ('a'), ('b')");
		db.fn.collation("held", () => 0);
		const before = callbacks.size;
		const running = db.prepare("select s from w order by s collate held").iterate();
		running.next();
		expect(thrown(() => db.fn.collation("held", () => 1))).toMatchObject({ code: "SQLITE_BUSY" });
		expect(callbacks.size).toBe(before);
		running.return();
		db.close();
		expect(() => db.fn.collation("late", () => 0)).toThrow(/database is closed/);
	});
});
