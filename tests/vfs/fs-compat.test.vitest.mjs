/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/fs-compat.test.vitest.mjs
 *	@Date: 2026-11-25T02:30:00-08:00 (1795602600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:30:00-08:00 (1795602600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, open, scratch } from "./fs-helpers.mjs";

/** node:sqlite (Node 22.5+), or undefined when this Node doesn't have it. */
let native;
try {
	native = createRequire(import.meta.url)("node:sqlite");
} catch {
	native = undefined;
}

afterEach(cleanup);

/** Schema and rows both sides write: plain rows with every value type, an FTS4 table and a Geopoly table. */
const SCHEMA = `
	CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, size REAL, data BLOB);
	INSERT INTO t (name, size, data) VALUES ('alpha', 1.5, x'00ff'), ('beta', NULL, NULL), ('gamma', -2, x'');
	CREATE VIRTUAL TABLE docs USING fts4(title, body);
	INSERT INTO docs VALUES ('wasm', 'sqlite compiled to webassembly'), ('native', 'the sqlite shipped with node');
	CREATE VIRTUAL TABLE shapes USING geopoly(label);
	INSERT INTO shapes (_shape, label) VALUES ('[[0,0],[2,0],[2,2],[0,2],[0,0]]', 'square'), ('[[5,5],[6,5],[5,6],[5,5]]', 'triangle');
`;

/** The queries both sides check, as one SQL string per result. */
const CHECKS = {
	rows: "SELECT name, size, hex(data) AS data FROM t ORDER BY id",
	fts: "SELECT title FROM docs WHERE docs MATCH 'sqlite AND node'",
	geo: "SELECT label, geopoly_area(_shape) AS area FROM shapes WHERE geopoly_overlap(_shape, '[[1,1],[3,1],[3,3],[1,3],[1,1]]')"
};
const EXPECTED = {
	rows: [
		{ name: "alpha", size: 1.5, data: "00FF" },
		{ name: "beta", size: null, data: "" },
		{ name: "gamma", size: -2, data: "" }
	],
	fts: [{ title: "native" }],
	geo: [{ label: "square", area: 4 }]
};

/** Runs CHECKS with `query(sql) → rows` and compares them with EXPECTED. */
function verify(query) {
	for (const [name, sql] of Object.entries(CHECKS))
		expect(
			query(sql).map((row) => ({ ...row })),
			name
		).toEqual(EXPECTED[name]);
}

describe.skipIf(!native)("compatibility with node:sqlite", () => {
	it("opens a file we wrote (WAL, closed cleanly) with the same rows, FTS4 and Geopoly tables", async () => {
		const dir = scratch();
		const path = join(dir, "ours.db");
		const db = await open(path);
		db.exec(SCHEMA);
		db.close();
		expect(readdirSync(dir)).toEqual(["ours.db"]);

		const other = new native.DatabaseSync(path);
		verify((sql) => other.prepare(sql).all());
		expect(other.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
		other.close();
	});

	for (const journal of ["wal", "delete"]) {
		it(`opens a file node:sqlite wrote (${journal}) and writes to it`, async () => {
			const dir = scratch();
			const path = join(dir, "theirs.db");
			const other = new native.DatabaseSync(path);
			other.exec(`PRAGMA journal_mode = ${journal}`);
			other.exec(SCHEMA);
			other.close();

			const db = await open(path);
			verify((sql) => db.exec(sql));
			db.exec("INSERT INTO t (name) VALUES ('delta')");
			db.close();

			const back = new native.DatabaseSync(path);
			expect(back.prepare("SELECT name FROM t ORDER BY id DESC LIMIT 1").get().name).toBe("delta");
			back.close();
		});
	}
});

// Logged so a run on a Node without node:sqlite says why the block above was skipped.
if (!native) console.warn(`fs-compat: node:sqlite is not available in Node ${process.version}; compatibility tests skipped`);
