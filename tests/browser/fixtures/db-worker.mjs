/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/browser/fixtures/db-worker.mjs
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

// The database worker the browser tests start: the host, with the wasm the test server serves from dist/.
import { listen } from "../../../src/worker/host.mts";

listen(globalThis, { wasm: new URL("/dist/sqlite3.wasm", location.origin) });
