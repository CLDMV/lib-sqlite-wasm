/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/cjs/entry.test.cjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T00:48:03-08:00 (1795596483)
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
	assert.deepEqual(Object.keys(cjs), ["PACKAGE_NAME"]);
});
