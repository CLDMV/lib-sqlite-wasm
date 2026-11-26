/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/api/values.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:53-08:00 (1795600253)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:15-08:00 (1795642215)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { connection, memory, thrown } from "./helpers.mjs";

const MAX = 2n ** 63n - 1n;
const MIN = -(2n ** 63n);

describe("values", () => {
	it("round-trips every storage class", async () => {
		const db = await memory();
		const echo = db.prepare("select ? as v, typeof(?1) as t");
		const cases = [
			[null, null, "null"],
			[undefined, null, "null"],
			[42, 42, "integer"],
			[-0, 0, "integer"],
			[1.5, 1.5, "real"],
			[1e300, 1e300, "real"],
			[2 ** 53, 2 ** 53, "real"],
			[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "integer"],
			[12n, 12, "integer"],
			[MAX, MAX, "integer"],
			[MIN, MIN, "integer"],
			[true, 1, "integer"],
			[false, 0, "integer"],
			["", "", "text"],
			["héllo ✓", "héllo ✓", "text"],
			["a\0b\0", "a\0b\0", "text"],
			[new Uint8Array([0, 1, 255]), new Uint8Array([0, 1, 255]), "blob"],
			[new Uint8Array(0), new Uint8Array(0), "blob"],
			[Buffer.from("buf"), new Uint8Array([98, 117, 102]), "blob"]
		];
		for (const [input, output, type] of cases) {
			const row = echo.get(input);
			expect(row.v).toEqual(output);
			expect(row.t).toBe(type);
		}
		db.close();
	});

	it("returns a fresh copy of a blob", async () => {
		const db = await memory();
		const select = db.prepare("select x'0102' as b");
		const first = select.get().b;
		first[0] = 9;
		expect(select.get().b).toEqual(new Uint8Array([1, 2]));
		db.close();
	});

	it("returns integers outside ±2^53 as bigint, or every integer in bigint mode", async () => {
		const db = await memory();
		const select = db.prepare("select 9007199254740991 as safe, 9007199254740992 as above, -9007199254740992 as below, 1.0 as real");
		expect(select.get()).toEqual({ safe: 9007199254740991, above: 9007199254740992n, below: -9007199254740992n, real: 1 });
		expect(db.prepare("select 1 as one, 1.5 as real", { bigint: true }).get()).toEqual({ one: 1n, real: 1.5 });
		expect(db.prepare("select ? as max, ? as min").get(MAX, MIN)).toEqual({ max: MAX, min: MIN });
		const big = await memory(undefined, { bigint: true });
		expect(big.prepare("select 1 as one").get()).toEqual({ one: 1n });
		expect(big.prepare("select 1 as one", { bigint: false }).get()).toEqual({ one: 1 });
		big.close();
		db.close();
	});

	it("rejects bigints outside 64 bits and values SQLite can't store", async () => {
		const db = await memory();
		const echo = db.prepare("select ?");
		expect(() => echo.get(MAX + 1n)).toThrow(RangeError);
		expect(() => echo.get(MIN - 1n)).toThrow(/does not fit in a 64-bit integer/);
		expect(thrown(() => echo.get(new Date(0))).message).toMatch(/cannot store a Date/);
		expect(thrown(() => echo.get(new Map())).message).toMatch(/cannot store an object \(\[object Map\]\)/);
		expect(thrown(() => echo.get(new Uint16Array(2))).message).toMatch(/\[object Uint16Array\]/);
		expect(thrown(() => echo.get(Symbol("s"))).message).toMatch(/cannot store a symbol/);
		expect(thrown(() => echo.get(() => 1)).message).toMatch(/cannot store a function/);
		// The statement stays usable.
		expect(echo.raw.get(1)).toEqual([1]);
		db.close();
	});

	it("stores and reads large text and blobs", async () => {
		const db = await memory();
		db.execute("create table t (s text, b blob)");
		const text = "x\0".repeat(300_000);
		const blob = new Uint8Array(1_000_000).map((_, i) => i % 251);
		db.prepare("insert into t values (?, ?)").run(text, blob);
		const row = db.prepare("select s, b, length(cast(s as blob)) as n from t").get();
		expect(row.s).toBe(text);
		expect(row.b).toEqual(blob);
		expect(row.n).toBe(600_000);
		db.close();
	});

	it("reports a bind SQLite refuses", async () => {
		const db = await memory();
		const state = connection(db);
		// SQLITE_LIMIT_LENGTH (0): the longest string or blob the connection accepts. SQLite won't set it below a small
		// floor, so the test uses a string well past any such floor.
		state.runtime.instance.exports.sqlite3_limit(state.db, 0, 30);
		const echo = db.prepare("select ? as v");
		expect(thrown(() => echo.get("x".repeat(1000)))).toMatchObject({ code: "SQLITE_TOOBIG", sql: "select ? as v" });
		expect(echo.get("ok")).toEqual({ v: "ok" });
		db.close();
	});
});
