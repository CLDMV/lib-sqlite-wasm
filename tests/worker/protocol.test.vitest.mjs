/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/worker/protocol.test.vitest.mjs
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
import { error, revive, serialize } from "../../src/worker/protocol.mts";
import sqlite from "../../src/index.mts";

describe("error", () => {
	it("is sqlite.error", () => {
		expect(error).toBe(sqlite.error);
	});
});

describe("serialize / revive", () => {
	it("keeps SQLite errors as SQLite errors across the boundary", () => {
		const wire = serialize(new error("UNIQUE constraint failed: t.a", 2067), "insert into t values (1)");
		expect(wire).toEqual({
			name: "sqlite.error",
			message: "UNIQUE constraint failed: t.a",
			code: "SQLITE_CONSTRAINT_UNIQUE",
			number: 2067,
			sql: "insert into t values (1)"
		});
		const back = revive(structuredClone(wire));
		expect(back).toBeInstanceOf(error);
		expect(back).toMatchObject({ name: "sqlite.error", code: "SQLITE_CONSTRAINT_UNIQUE", number: 2067, sql: "insert into t values (1)" });
	});

	it("prefers the error's own sql and leaves sql off when there is none", () => {
		expect(serialize(new error("bad", 1, "select own"), "select call")).toMatchObject({ sql: "select own" });
		const busy = Object.assign(new Error("in another tab"), { number: 5 });
		expect(serialize(busy)).toEqual({ name: "sqlite.error", message: "in another tab", code: "SQLITE_BUSY", number: 5 });
		expect(revive(serialize(busy)).sql).toBeUndefined();
	});

	it("sends other errors by name and message", () => {
		expect(serialize(new RangeError("too big"))).toEqual({ name: "RangeError", message: "too big" });
		expect(serialize(Object.assign(new Error("odd"), { number: "5" }))).toEqual({ name: "Error", message: "odd" });
		expect(serialize("plain string")).toEqual({ name: "Error", message: "plain string" });
		const back = revive({ name: "RangeError", message: "too big" });
		expect(back).not.toBeInstanceOf(error);
		expect(back).toMatchObject({ name: "RangeError", message: "too big" });
	});
});
