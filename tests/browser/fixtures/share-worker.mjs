/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/browser/fixtures/share-worker.mjs
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

// The database worker the sharing tests start: the host, plus pause(ms), which keeps a statement running so a test can
// close the leader's tab while a write is still in its worker, and crash(), which throws an uncaught error in the worker
// right after the statement.
import { listen } from "../../../src/worker/host.mts";

listen(globalThis, {
	wasm: new URL("/dist/sqlite3.wasm", location.origin),
	setup(db) {
		db.fn.scalar("pause", (ms) => {
			const end = Date.now() + ms;
			while (Date.now() < end);
			return ms;
		});
		db.fn.scalar("crash", () => {
			setTimeout(() => {
				throw new Error("crash");
			});
			return 1;
		});
	}
});
