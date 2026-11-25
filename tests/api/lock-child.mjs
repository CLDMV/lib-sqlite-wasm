/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/api/lock-child.mjs
 *	@Date: 2026-11-25T06:00:00-08:00 (1795615200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T06:00:00-08:00 (1795615200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Child process for the lock tests: opens a database through `sqlite.open()` with a given lock and
 * reports on stdout.
 *
 *   node lock-child.mjs <db> <lock> [ms]   open (journal "delete"), write a row, print "open <info.lock>", then close on
 *                                         a "close" line on stdin (or after ms) and print "closed"
 */
import { createInterface } from "node:readline";
import sqlite from "../../src/index.mts";

const [path, lock, after] = process.argv.slice(2);

const db = await sqlite.open(path, { lock, journal: "delete" });
db.execute("CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES ('child')");
console.log(`open ${db.info.lock}`);
const done = () => {
	db.close();
	console.log("closed");
	process.exit(0);
};
if (after) setTimeout(done, Number(after));
createInterface({ input: process.stdin }).on("line", (line) => line === "close" && done());
