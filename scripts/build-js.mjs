/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: scripts/build-js.mjs
 *	@Date: 2026-11-25T19:16:21-08:00 (1795662981)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T19:16:33-08:00 (1795662993)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Builds dist/ from src/: one output file per source module, in the same layout.
 *
 *   1. tsc compiles src/**\/*.mts to dist/**\/*.mjs (.configs/tsconfig.build.json). `rewriteRelativeImportExtensions`
 *      turns the `.mts` import specifiers into `.mjs`, so the output runs as is.
 *   2. esbuild minifies each file in place, keeping names (stack traces, fn.name) and chaining the source maps back to
 *      src/. Nothing is bundled, so every module exists once and the entries share it by plain relative imports.
 *   3. The hand-written CommonJS wrappers (src/index.cjs, src/drizzle.cjs) are copied verbatim.
 *
 * dist/ is cleared first; `npm run build:wasm` then puts sqlite3.wasm back (it builds into a cache and copies).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

rmSync("dist", { recursive: true, force: true });

const tsc = spawnSync(
	process.execPath,
	[join(require.resolve("typescript/package.json"), "..", "bin", "tsc"), "-p", ".configs/tsconfig.build.json"],
	{ stdio: "inherit" }
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const files = readdirSync("dist", { recursive: true })
	.map(String)
	.filter((file) => file.endsWith(".mjs"))
	.map((file) => join("dist", file));

await build({
	entryPoints: files,
	outdir: "dist",
	outbase: "dist",
	allowOverwrite: true,
	outExtension: { ".js": ".mjs" },
	bundle: false,
	format: "esm",
	platform: "neutral",
	target: ["node20", "es2022"],
	minify: true,
	keepNames: true,
	sourcemap: true,
	logLevel: "warning"
});

for (const name of ["index", "drizzle"]) copyFileSync(`src/${name}.cjs`, `dist/${name}.cjs`);
