/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/vfs/fs-crash.test.vitest.mjs
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

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { child, cleanup, open, scratch } from "./fs-helpers.mjs";

afterEach(cleanup);

/** Kills `proc` with SIGKILL and waits for it to go. */
async function kill(proc) {
	proc.proc.kill("SIGKILL");
	expect(await proc.exited).toMatchObject({ signal: "SIGKILL" });
}

describe("crash safety", () => {
	for (const journal of ["wal", "truncate", "delete"]) {
		it(`rolls back a transaction killed midway (${journal})`, async () => {
			const dir = scratch();
			const path = join(dir, "mid.db");
			const writer = child("mid", path, journal);
			expect(await writer.next()).toBe("mid");
			// The open transaction has reached the disk: WAL frames, or a hot journal plus changed database pages.
			const side = journal === "wal" ? `${path}-wal` : `${path}-journal`;
			expect(existsSync(side) && statSync(side).size > 0).toBe(true);
			await kill(writer);

			const db = await open(path, { journal, timeout: 0 });
			expect(db.exec("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
			expect(db.exec("SELECT count(*) AS n, max(batch) AS last FROM t")).toEqual([{ n: 100, last: 0 }]);
			db.close();
		});

		it(`keeps every committed transaction whole when killed at a random point (${journal})`, async () => {
			const dir = scratch();
			const path = join(dir, "loop.db");
			const writer = child("loop", path, journal);
			expect(await writer.next()).toBe("running");
			await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 300)));
			await kill(writer);

			const db = await open(path, { journal, timeout: 0 });
			expect(db.exec("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
			const [{ n, batches }] = db.exec("SELECT count(*) AS n, count(DISTINCT batch) AS batches FROM t");
			expect(n).toBeGreaterThanOrEqual(50);
			expect(n).toBe(batches * 50);
			db.close();
		});
	}
});
