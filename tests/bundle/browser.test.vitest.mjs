/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/bundle/browser.test.vitest.mjs
 *	@Date: 2026-11-25T08:00:00-08:00 (1795622400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T08:00:00-08:00 (1795622400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The browser bundles (dist/host.mjs, dist/worker.mjs) carry no Node import at all: tsup's `nodeless`
 * plugin replaces every `node:` module reached from the browser entries with a stub that throws when loaded. The
 * pretest script builds dist/ first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = (name) => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url));

/** `import ... from "node:x"`, `import("node:x")`, `require("node:x")` and bare `import "node:x"`, minified or not. */
const NODE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]node:/;

describe("browser bundles", () => {
	for (const name of ["host.mjs", "worker.mjs"]) {
		it(`${name} has no node: imports`, () => {
			const code = readFileSync(dist(name), "utf8");
			expect(code).not.toMatch(NODE_IMPORT);
		});
	}

	it("the Node bundle still imports node: modules (the check can see them)", () => {
		expect(readFileSync(dist("index.mjs"), "utf8")).toMatch(NODE_IMPORT);
	});

	it("the host bundle stubs the Node-only paths with a clear error", () => {
		expect(readFileSync(dist("host.mjs"), "utf8")).toMatch(/sqlite-wasm: node:fs is not available in a browser/);
	});
});
