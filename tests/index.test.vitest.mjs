/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/index.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
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
import { MemoryDriver, openRaw, PACKAGE_NAME, RawSqliteError } from "@cldmv/sqlite-wasm";

describe("package entry", () => {
	it("exports the package name from the ESM entry", () => {
		expect(PACKAGE_NAME).toBe("@cldmv/sqlite-wasm");
	});

	// Under `npm run test:dist` this runs against dist/index.mjs, which finds dist/sqlite3.wasm beside itself.
	it("opens a memory database through the package entry", async () => {
		const db = await openRaw("entry.db", { driver: new MemoryDriver() });
		expect(db.exec("select 1 + 1 as two")).toEqual([{ two: 2 }]);
		expect(() => db.exec("nonsense")).toThrow(RawSqliteError);
		db.close();
	});
});
