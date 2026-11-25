/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-25T00:47:21-08:00 (1795596441)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T00:57:11-08:00 (1795597031)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config: produces the published dist/ output from src/.
 *
 * Two builds, one self-contained ESM bundle per entry:
 *   - Node: dist/index.mjs. The CommonJS entry is not built: `src/index.cjs` is a hand-written require(esm) wrapper
 *     around the built `index.mjs`, and `onSuccess` copies it verbatim into dist/ beside the bundle, so it never
 *     duplicates the library.
 *   - Browser: dist/host.mjs (the worker host) and dist/worker.mjs (the main-thread client), ESM only. Their source
 *     graph reaches Node-only code behind lazy imports and environment checks (the node-fs driver, the node:fs wasm
 *     reader, the "db" lock's node:os). The `nodeless` plugin swaps every `node:` module for a stub that throws when
 *     loaded, so these bundles contain no Node import at all, and a Node-only path reached by mistake in a browser
 *     fails with a clear message instead of a module resolution error.
 */
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** Node entries, keyed by their path under dist/ (without extension). Each has a hand-written `src/<name>.cjs` wrapper. */
const entries = {
	index: "src/index.mts"
};

/** Browser entries, ESM only (no CJS wrapper). */
const browser = {
	host: "src/worker/host.mts",
	worker: "src/worker/client.mts"
};

/** esbuild plugin: every `node:` import becomes a module that throws "<name> is not available in a browser". */
const nodeless = {
	name: "nodeless",
	setup(build) {
		build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "nodeless" }));
		build.onLoad({ filter: /.*/, namespace: "nodeless" }, (args) => ({
			// No import/export syntax: esbuild treats it as CommonJS, so any named import from it is allowed and the
			// throw only happens when the importing module is evaluated.
			contents: `throw new Error(${JSON.stringify(`sqlite-wasm: ${args.path} is not available in a browser`)});`,
			loader: "js"
		}));
	}
};

/** Settings both builds share. */
const shared = {
	format: ["esm"],
	outDir: "dist",
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	// Keep function and class names through minification (stack traces, fn.name).
	keepNames: true,
	// Keep `node:` specifiers on built-in imports (tsup strips them by default).
	removeNodeProtocol: false,
	// The two builds run in parallel into one folder, so neither cleans it; it is emptied here, once, instead.
	clean: false,
	outExtension() {
		return { js: ".mjs" };
	}
};

rmSync("dist", { recursive: true, force: true });

export default defineConfig([
	{
		...shared,
		entry: entries,
		target: "node20",
		platform: "node",
		// tsup calls this on the resolved options, so `this.outDir` is the directory the build actually wrote to.
		onSuccess() {
			for (const name of Object.keys(entries)) copyFileSync(`src/${name}.cjs`, join(this.outDir, `${name}.cjs`));
		}
	},
	{
		...shared,
		entry: browser,
		target: "es2022",
		platform: "browser",
		esbuildPlugins: [nodeless]
	}
]);
