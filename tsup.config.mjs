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
 * One ESM build for every entry, with code splitting: dist/index.mjs (Node), dist/drizzle.mjs, dist/host.mjs (the
 * worker host) and dist/worker.mjs (the main-thread client) import the modules they share from chunks in dist/, so
 * each module (the error class, the protocol, values, options, the wasm loader, ...) exists once and `instanceof`
 * works across entries.
 *
 * The CommonJS entries are not built: `src/index.cjs` and `src/drizzle.cjs` are hand-written require(esm) wrappers
 * around the built `.mjs` files, and `onSuccess` copies them verbatim into dist/, so they never duplicate the library.
 *
 * The browser entries must not reach a `node:` module, and with shared chunks they can't get a stub of their own.
 * The shared code therefore never imports one: Node-only code is behind core/platform.mts, which src/node.mts fills
 * in, and only the Node entry imports that (tests/bundle/browser.test.vitest.mjs checks the browser entries' chunk
 * graph).
 */
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** Entries, keyed by their path under dist/ (without extension). */
const entries = {
	index: "src/index.mts",
	drizzle: "src/drizzle.mts",
	host: "src/worker/host.mts",
	worker: "src/worker/client.mts"
};

/** Entries with a hand-written `src/<name>.cjs` wrapper; the browser entries are ESM only. */
const wrapped = ["index", "drizzle"];

rmSync("dist", { recursive: true, force: true });

export default defineConfig({
	entry: entries,
	format: ["esm"],
	outDir: "dist",
	splitting: true,
	// Node for the Node entries; the browser entries' code runs in both (their only Node-only paths are behind platform.mts).
	platform: "node",
	target: ["node20", "es2022"],
	sourcemap: true,
	dts: false,
	minify: true,
	// Keep function and class names through minification (stack traces, fn.name).
	keepNames: true,
	// Keep `node:` specifiers on built-in imports (tsup strips them by default).
	removeNodeProtocol: false,
	clean: false,
	outExtension() {
		return { js: ".mjs" };
	},
	// tsup calls this on the resolved options, so `this.outDir` is the directory the build actually wrote to.
	onSuccess() {
		for (const name of wrapped) copyFileSync(`src/${name}.cjs`, join(this.outDir, `${name}.cjs`));
	}
});
