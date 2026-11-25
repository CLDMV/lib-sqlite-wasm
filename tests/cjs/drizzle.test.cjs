/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/cjs/drizzle.test.cjs
 *	@Date: 2026-11-25T04:30:00-08:00 (1795609800)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:20:59-08:00 (1795634459)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const dist = path.resolve(__dirname, "..", "..", "dist");

// Run after `npm run build`: the built CommonJS entry of ./drizzle re-exports the built ESM entry.
test("dist/drizzle.cjs re-exports dist/drizzle.mjs", () => {
	const cjs = require(path.join(dist, "drizzle.cjs"));
	assert.deepEqual(Object.keys(cjs).sort(), ["drizzle", "migrate"]);
});

test("dist/drizzle.cjs drives a database opened through dist/index.cjs", async () => {
	const { open } = require(path.join(dist, "index.cjs"));
	const { drizzle } = require(path.join(dist, "drizzle.cjs"));
	const { sql } = require("drizzle-orm");
	const raw = await open("cjs-drizzle.db", { storage: "memory" });
	const db = drizzle(raw);
	db.run(sql`create table t (x text)`);
	db.run(sql`insert into t values (${"from cjs"})`);
	assert.deepEqual(db.all(sql`select x from t`), [{ x: "from cjs" }]);
	assert.equal(db.$client, raw);
	raw.close();
});
