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
import { error, label, revive, serialize } from "../../src/worker/protocol.mts";
import { RawSqliteError } from "../../src/core/raw.mts";

describe("result code names", () => {
	it("names extended codes, falls back to the primary name, then UNKNOWN", () => {
		expect(label(2067)).toBe("SQLITE_CONSTRAINT_UNIQUE");
		expect(label(19)).toBe("SQLITE_CONSTRAINT");
		expect(label(5 | (99 << 8))).toBe("SQLITE_BUSY");
		expect(label(250)).toBe("SQLITE_UNKNOWN");
	});
});

describe("error", () => {
	it("carries code, number and sql", () => {
		const made = new error("boom", 2067, undefined, "insert");
		expect(made).toBeInstanceOf(Error);
		expect(made).toMatchObject({ name: "SqliteError", message: "boom", code: "SQLITE_CONSTRAINT_UNIQUE", number: 2067, sql: "insert" });
		expect(new error("x", 5, "SQLITE_BUSY").sql).toBeUndefined();
	});
});

describe("serialize / revive", () => {
	it("keeps SQLite errors as SQLite errors across the boundary", () => {
		const wire = serialize(new RawSqliteError("UNIQUE constraint failed: t.a", 2067), "insert into t values (1)");
		expect(wire).toEqual({
			name: "SqliteError",
			message: "UNIQUE constraint failed: t.a",
			code: "SQLITE_CONSTRAINT_UNIQUE",
			number: 2067,
			sql: "insert into t values (1)"
		});
		const back = revive(structuredClone(wire));
		expect(back).toBeInstanceOf(error);
		expect(back).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", number: 2067, sql: "insert into t values (1)" });
	});

	it("keeps an explicit code and leaves sql off when there is none", () => {
		const busy = Object.assign(new Error("in another tab"), { code: "SQLITE_BUSY", number: 5 });
		expect(serialize(busy)).toEqual({ name: "SqliteError", message: "in another tab", code: "SQLITE_BUSY", number: 5 });
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
