/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/scripts/pack.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:06-08:00 (1795598286)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The published tarball: the wasm module ships, build inputs and caches do not.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("npm pack", () => {
	// dist/sqlite3.wasm is produced by `npm run build:wasm`, which the pretest script runs.
	it("ships dist/sqlite3.wasm and none of the build inputs", () => {
		const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			encoding: "utf8",
			shell: process.platform === "win32"
		});
		expect(result.status).toBe(0);
		/** @type {string[]} */
		const files = JSON.parse(result.stdout)[0].files.map((/** @type {{ path: string }} */ f) => f.path);
		expect(files).toContain("dist/sqlite3.wasm");
		expect(files).toContain("package.json");
		expect(files.filter((f) => /^(\.cache|src|scripts|tests|tmp|sqlite\.version\.json)/.test(f) || f.endsWith(".map"))).toEqual([]);
		expect(files.filter((f) => !/^(dist|types)\//.test(f)).sort()).toEqual(["LICENSE", "README.md", "package.json"]);
	});
});
