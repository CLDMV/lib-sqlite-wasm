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
 * @fileoverview The browser entries (dist/host.mjs, dist/worker.mjs) reach no Node import at all, through any of the
 * chunks they load: the shared code never imports a `node:` module (Node-only code is behind core/platform.mts, which
 * only the Node entry fills in). The pretest script builds dist/ first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = (name) => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url));

/** `import ... from "node:x"`, `import("node:x")`, `require("node:x")` and bare `import "node:x"`, minified or not. */
const NODE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]node:/;
/** Static and dynamic imports of another file in dist/. */
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]\.\/([^"'`]+)["'`]/g;

/** `name` and every dist/ file it imports, directly or through others. */
function graph(name, seen = new Set()) {
	if (seen.has(name)) return seen;
	seen.add(name);
	for (const [, next] of readFileSync(dist(name), "utf8").matchAll(LOCAL_IMPORT)) graph(next, seen);
	return seen;
}

describe("browser bundles", () => {
	for (const name of ["host.mjs", "worker.mjs"]) {
		it(`${name} and the chunks it loads have no node: imports`, () => {
			const files = [...graph(name)];
			expect(files.length).toBeGreaterThan(1);
			for (const file of files) expect({ file, node: NODE_IMPORT.test(readFileSync(dist(file), "utf8")) }).toEqual({ file, node: false });
		});
	}

	it("the Node entry's graph still imports node: modules (the check can see them)", () => {
		expect([...graph("index.mjs")].some((file) => NODE_IMPORT.test(readFileSync(dist(file), "utf8")))).toBe(true);
	});

	it("shares chunks between the entries", () => {
		const host = graph("host.mjs");
		expect([...graph("index.mjs")].filter((file) => file !== "index.mjs" && host.has(file))).not.toEqual([]);
	});
});
