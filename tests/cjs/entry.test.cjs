/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/cjs/entry.test.cjs
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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const dist = path.resolve(__dirname, "..", "..", "dist");

// Run after `npm run build`: checks that the built CommonJS entry re-exports the built ESM entry.
test("dist/index.cjs re-exports dist/index.mjs", () => {
	const cjs = require(path.join(dist, "index.cjs"));
	// Node's require(esm) adds __esModule when the module has a default export.
	assert.deepEqual(Object.keys(cjs).sort(), ["__esModule", "default", "err", "error", "open"]);
	assert.equal(cjs.default.open, cjs.open);
	assert.equal(cjs.err, cjs.error);
});

// require(esm) can't wait for top-level await, so the wasm must load lazily; this opens a database through the shim.
test("dist/index.cjs opens a memory database", async () => {
	const { open } = require(path.join(dist, "index.cjs"));
	const db = await open("cjs.db", { storage: "memory" });
	db.execute("create table t(x); insert into t values ('from cjs');");
	assert.deepEqual(db.prepare("select x, sqlite_version() as v from t").get(), {
		x: "from cjs",
		v: require("../../sqlite.version.json").sqlite.version
	});
	db.close();
});
