/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/drizzle/bundle.test.vitest.mjs
 *	@Date: 2026-11-25T04:30:00-08:00 (1795613400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T04:30:00-08:00 (1795613400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The `./drizzle` bundle (dist/drizzle.mjs) leaves drizzle-orm to the app (it is an optional peer
 * dependency), imports no Node module, so a browser bundler can take it, and is wired into the package exports. The
 * pretest script builds dist/ first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

describe("the drizzle entry", () => {
	const code = read("dist/drizzle.mjs");

	it("imports drizzle-orm instead of bundling it", () => {
		expect(code).toMatch(/from\s*"drizzle-orm\/sqlite-proxy"/);
		expect(code).toMatch(/from\s*"drizzle-orm\/better-sqlite3\/session"/);
		expect(code.length).toBeLessThan(20000);
	});

	it("has no node: imports", () => {
		expect(code).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]node:/);
	});

	it("does not import the migrators, which read files", () => {
		expect(code).not.toMatch(/migrator/);
	});

	it("is exported with a dev condition, types and a CommonJS shim", () => {
		const entry = JSON.parse(read("package.json")).exports["./drizzle"];
		expect(entry).toMatchObject({
			"sqlite-wasm-dev": { import: "./src/drizzle.mts" },
			types: "./types/src/drizzle.d.mts",
			import: "./dist/drizzle.mjs",
			require: "./dist/drizzle.cjs"
		});
		expect(JSON.parse(read("package.json")).peerDependenciesMeta["drizzle-orm"].optional).toBe(true);
	});
});
