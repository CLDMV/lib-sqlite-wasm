/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/vfs/fs-child.mjs
 *	@Date: 2026-11-25T01:49:24-08:00 (1795600164)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:17-08:00 (1795642217)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Child process for the node-fs driver tests. Runs src/ directly through Node's type stripping and
 * reports progress as lines on stdout.
 *
 *   node fs-child.mjs hold <db> [ms]          open, print "open", close on a "close" line on stdin (or after ms), print "closed"
 *   node fs-child.mjs exit <db>               open, print "open", exit without closing
 *   node fs-child.mjs mid <db> <journal>      commit 100 rows, start a big transaction, print "mid", then hang
 *   node fs-child.mjs loop <db> <journal>     commit batches of 50 rows forever, print "running" after the first
 */
import { createInterface } from "node:readline";
// A child process gets no vitest setup file: it takes the Node capabilities the way the main entry does.
import { provide } from "../../src/core/platform.mts";
import { capabilities } from "../../src/node.mts";
import { open } from "./fs-helpers.mjs";

provide(capabilities);

const [mode, path, extra] = process.argv.slice(2);

/** Blocks this process for good; the parent kills it. */
function hang() {
	for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}

if (mode === "hold") {
	const db = await open(path);
	db.exec("CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES ('child')");
	console.log("open");
	const done = () => {
		db.close();
		console.log("closed");
		process.exit(0);
	};
	if (extra) setTimeout(done, Number(extra));
	createInterface({ input: process.stdin }).on("line", (line) => line === "close" && done());
} else if (mode === "exit") {
	await open(path);
	console.log("open");
	process.exit(0);
} else if (mode === "mid") {
	const db = await open(path, { journal: extra });
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, batch INTEGER, payload BLOB)");
	db.exec("BEGIN; " + "INSERT INTO t (batch, payload) VALUES (0, randomblob(100));".repeat(100) + " COMMIT;");
	// A tiny page cache makes SQLite spill the open transaction to disk (the WAL, or the database after journaling).
	db.exec("PRAGMA cache_size = 5");
	db.exec("BEGIN");
	db.exec(
		"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO t (batch, payload) SELECT 1, randomblob(1000) FROM n"
	);
	console.log("mid");
	hang();
} else if (mode === "loop") {
	const db = await open(path, { journal: extra });
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, batch INTEGER, payload BLOB)");
	for (let batch = 0; ; batch++) {
		db.exec(
			`BEGIN; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) INSERT INTO t (batch, payload) SELECT ${batch}, randomblob(500) FROM n; COMMIT;`
		);
		if (batch === 0) console.log("running");
	}
} else {
	throw new Error(`fs-child: unknown mode ${mode}`);
}
