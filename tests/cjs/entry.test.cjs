/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/cjs/entry.test.cjs
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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Run after `npm run build`: checks that the built CommonJS entry re-exports the built ESM entry.
test("dist/index.cjs re-exports dist/index.mjs", () => {
	const dist = path.resolve(__dirname, "..", "..", "dist");
	const cjs = require(path.join(dist, "index.cjs"));
	assert.equal(cjs.PACKAGE_NAME, "@cldmv/sqlite-wasm");
	assert.deepEqual(Object.keys(cjs).sort(), ["MemoryDriver", "PACKAGE_NAME", "RawSqliteError", "openRaw"]);
});

// require(esm) can't wait for top-level await, so the wasm must load lazily; this opens a database through the shim.
test("dist/index.cjs opens a memory database", async () => {
	const { openRaw, MemoryDriver } = require(path.resolve(__dirname, "..", "..", "dist", "index.cjs"));
	const driver = new MemoryDriver();
	const db = await openRaw("cjs.db", { driver });
	db.exec("create table t(x); insert into t values ('from cjs');");
	assert.deepEqual(db.exec("select x, sqlite_version() as v from t"), [
		{ x: "from cjs", v: require("../../sqlite.version.json").sqlite.version }
	]);
	db.close();
	assert.deepEqual(driver.files(), ["cjs.db"]);
});
