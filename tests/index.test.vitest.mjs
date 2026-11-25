/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/index.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:39:09-08:00 (1795603149)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import sqlite, { err, error, open } from "@cldmv/sqlite-wasm";

describe("package entry", () => {
	it("default-exports sqlite with open and error (alias err)", () => {
		expect(Object.keys(sqlite).sort()).toEqual(["err", "error", "open"]);
		expect(sqlite.open).toBe(open);
		expect(sqlite.error).toBe(error);
		expect(sqlite.err).toBe(sqlite.error);
		expect(err).toBe(error);
		expect(Object.isFrozen(sqlite)).toBe(true);
	});

	// Under `npm run test:dist` this runs against dist/index.mjs, which finds dist/sqlite3.wasm beside itself.
	it("opens a memory database through the package entry", async () => {
		const db = await sqlite.open("entry.db", { storage: "memory" });
		expect(db.prepare("select 1 + 1 as two").get()).toEqual({ two: 2 });
		expect(() => db.execute("nonsense")).toThrow(sqlite.error);
		db.close();
	});
});
