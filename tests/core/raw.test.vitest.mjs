/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/core/raw.test.vitest.mjs
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

import { describe, expect, it } from "vitest";
import { openRaw, RawSqliteError, sqliteError } from "../../src/core/raw.mts";
import { loadSqliteModule } from "../../src/core/loader.mts";
import { SQLITE_OPEN_READWRITE } from "../../src/core/constants.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

describe("openRaw", () => {
	it("returns every column type", async () => {
		const db = await openRaw("values.db");
		const [row] = db.exec(
			"select 42 as i, 9007199254740993 as big, -9007199254740993 as small, 1.5 as f, 'héllo' || char(0) || 'x' as t, x'00ff10' as b, x'' as empty, null as n"
		);
		expect(row).toEqual({
			i: 42,
			big: 9007199254740993n,
			small: -9007199254740993n,
			f: 1.5,
			t: "héllo\0x",
			b: new Uint8Array([0, 255, 16]),
			empty: new Uint8Array(0),
			n: null
		});
		db.close();
	});

	it("returns the rows of the last statement and skips trailing comments", async () => {
		const db = await openRaw("multi.db");
		expect(db.exec("create table t(x); insert into t values (1), (2); select x from t order by x; -- done")).toEqual([{ x: 1 }, { x: 2 }]);
		expect(db.exec("   ")).toEqual([]);
		db.close();
	});

	it("throws RawSqliteError for prepare and step failures", async () => {
		const db = await openRaw("errors.db");
		expect(() => db.exec("selec 1")).toThrow(RawSqliteError);
		expect(() => db.exec("selec 1")).toThrow(/syntax error/);
		db.exec("create table t(x not null)");
		let error;
		try {
			db.exec("insert into t values (null)");
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ name: "RawSqliteError", errcode: 1299 }); // SQLITE_CONSTRAINT_NOTNULL
		expect(error.message).toMatch(/NOT NULL constraint failed/);
		db.close();
	});

	it("fails to open a missing database without CREATE", async () => {
		await expect(openRaw("missing.db", { flags: SQLITE_OPEN_READWRITE })).rejects.toMatchObject({
			errcode: 14,
			message: "unable to open database file"
		});
	});

	it("is a no-op to close twice and refuses exec after close", async () => {
		const db = await openRaw("closed.db", { driver: new MemoryDriver(), module: await loadSqliteModule() });
		db.close();
		db.close();
		expect(() => db.exec("select 1")).toThrow(/database is closed/);
	});

	it("builds an error from the result code alone when there is no connection", async () => {
		const db = await openRaw("nodb.db");
		expect(sqliteError(db.sqlite, 0, 5)).toMatchObject({ errcode: 5, message: "database is locked" });
		db.close();
	});
});
