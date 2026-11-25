/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /.configs/vitest.browser.config.mjs
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

// Browser tests (npm run test:browser): OPFS and the worker client in headless Chromium through Playwright. They are
// named *.browser.vitest.mjs so the Node runner (tests/run-vitest.mjs, *.test.vitest.mjs) never picks them up, and they
// need dist/sqlite3.wasm, so build first.
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
	root,
	test: {
		include: ["tests/browser/**/*.browser.vitest.mjs"],
		testTimeout: 30000,
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(),
			instances: [{ browser: "chromium" }]
		}
	}
});
