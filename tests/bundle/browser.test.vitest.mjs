/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/bundle/browser.test.vitest.mjs
 *	@Date: 2026-11-25T03:18:37-08:00 (1795605517)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T19:16:36-08:00 (1795662996)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview dist/ is one file per source module, in the src/ layout, and the browser entries (dist/worker/host.mjs,
 * dist/worker/client.mjs) reach no Node import through any module they load: the shared code never imports a `node:`
 * module (Node-only code is behind core/platform.mts, which only the Node entry fills in). The pretest script builds
 * dist/ first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = (name) => join(root, "dist", name);

/** `import ... from "node:x"`, `import("node:x")`, `require("node:x")` and bare `import "node:x"`, minified or not. */
const NODE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]node:/;
/** Static and dynamic relative imports (`./x.mjs`, `../x/y.mjs`). */
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`](\.\.?\/[^"'`]+)["'`]/g;

/** `name` (a path under dist/) and every dist/ file it imports, directly or through others. */
function graph(name, seen = new Set()) {
	if (seen.has(name)) return seen;
	seen.add(name);
	for (const [, next] of readFileSync(dist(name), "utf8").matchAll(LOCAL_IMPORT)) graph(normalize(join(dirname(name), next)), seen);
	return seen;
}

/** Files under `dir`, relative to it. */
const list = (dir) => readdirSync(join(root, dir), { recursive: true }).map(String);

describe("dist/ layout", () => {
	it("has one .mjs per source module, at the same path, and no generated chunks", () => {
		const sources = list("src")
			.filter((file) => file.endsWith(".mts"))
			.map((file) => file.replace(/\.mts$/, ".mjs"))
			.sort();
		const built = list("dist")
			.filter((file) => file.endsWith(".mjs"))
			.sort();
		expect(built).toEqual(sources);
	});

	it("ships the CommonJS wrappers and the wasm at the top", () => {
		const top = readdirSync(join(root, "dist"));
		expect(top).toEqual(expect.arrayContaining(["index.cjs", "drizzle.cjs", "sqlite3.wasm"]));
	});
});

describe("browser entries", () => {
	for (const name of ["worker/host.mjs", "worker/client.mjs"]) {
		it(`${name} and the modules it loads have no node: imports`, () => {
			const files = [...graph(name)];
			expect(files.length).toBeGreaterThan(1);
			for (const file of files) expect({ file, node: NODE_IMPORT.test(readFileSync(dist(file), "utf8")) }).toEqual({ file, node: false });
		});
	}

	it("the Node entry's graph still imports node: modules (the check can see them)", () => {
		expect([...graph("index.mjs")].some((file) => NODE_IMPORT.test(readFileSync(dist(file), "utf8")))).toBe(true);
	});

	it("shares modules between the entries", () => {
		const host = graph("worker/host.mjs");
		expect([...graph("index.mjs")]).toEqual(expect.arrayContaining(["api/error.mjs"]));
		expect([...graph("index.mjs")].filter((file) => file !== "index.mjs" && host.has(file))).not.toEqual([]);
	});
});
