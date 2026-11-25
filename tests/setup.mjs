/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/setup.mjs
 *	@Date: 2026-11-25T09:00:00-08:00 (1795626000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T09:00:00-08:00 (1795626000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

// Node tests that import src/ modules directly, not through src/index.mts, still get the Node capabilities (reading the
// wasm from disk, the node-fs driver, the "db" lock's process checks), as the package's main entry provides them.
import { provide } from "../src/core/platform.mts";
import { capabilities } from "../src/node.mts";

provide(capabilities);
