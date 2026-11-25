/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-25T00:47:21-08:00 (1795596441)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T00:48:03-08:00 (1795596483)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config: produces the published dist/ output from src/.
 *
 * One self-contained ESM bundle for the root entry, written to dist/index.mjs. The CommonJS entry is not built:
 * `src/index.cjs` is a thin require(esm) wrapper around its sibling `index.mjs`, and `onSuccess` copies it verbatim
 * into dist/ beside the bundle, so it never duplicates the library.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** Public entries, keyed by their path under dist/ (without extension). */
const entries = {
	index: "src/index.mjs"
};

export default defineConfig({
	entry: entries,
	format: ["esm"],
	outDir: "dist",
	target: "node20",
	platform: "node",
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	// Keep function and class names through minification (stack traces, fn.name).
	keepNames: true,
	// Keep `node:` specifiers on built-in imports (tsup strips them by default).
	removeNodeProtocol: false,
	clean: true,
	outExtension() {
		return { js: ".mjs" };
	},
	// tsup calls this on the resolved options, so `this.outDir` is the directory the build actually wrote to.
	onSuccess() {
		for (const name of Object.keys(entries)) copyFileSync(`src/${name}.cjs`, join(this.outDir, `${name}.cjs`));
	}
});
