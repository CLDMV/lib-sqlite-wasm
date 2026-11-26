/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/core/browser-loader.mts
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T19:16:34-08:00 (1795662994)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Compiles sqlite3.wasm in a browser: fetch plus `WebAssembly.compileStreaming`, so the module compiles
 * while it downloads. The Node loader (loader.mts) reads the file with node:fs instead; both produce a
 * `WebAssembly.Module` for `instantiateSqlite()`.
 *
 * The default location is written as `new URL("../sqlite3.wasm", import.meta.url)` on purpose: Vite, webpack and
 * Parcel recognise that exact pattern and emit the wasm as an asset next to the bundle. When a bundler doesn't, or
 * the file is served from somewhere else, pass its URL (or the bytes, a Response or a compiled module) instead.
 */

/** Anything `load()` can turn into a compiled module. */
export type source = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;

/** The fetch function `load()` uses; injectable for tests. */
export type fetcher = (url: URL) => Promise<Response>;

/** Default locations, in order: dist/sqlite3.wasm from dist/core/ in the package, then from src/core/ in a checkout. */
export function candidates(): URL[] {
	return [new URL("../sqlite3.wasm", import.meta.url), new URL("../../dist/sqlite3.wasm", import.meta.url)];
}

/** Compiles a fetched response, streaming when the server sends the wasm MIME type. */
export async function compile(response: Response): Promise<WebAssembly.Module> {
	if (!response.ok) throw new Error(`sqlite-wasm: fetching ${response.url || "sqlite3.wasm"} failed with HTTP ${response.status}`);
	if (typeof WebAssembly.compileStreaming === "function") {
		try {
			return await WebAssembly.compileStreaming(response.clone());
		} catch (error) {
			// compileStreaming refuses a response without `Content-Type: application/wasm` (TypeError); the bytes are
			// still fine to compile the slow way. Anything else (a CompileError) is a real failure.
			if (!(error instanceof TypeError)) throw error;
		}
	}
	return WebAssembly.compile(await response.arrayBuffer());
}

let cached: Promise<WebAssembly.Module> | undefined;

/** Fetches the default candidates in order, skipping any that answer 404. */
async function fallback(get: fetcher): Promise<WebAssembly.Module> {
	const tried: string[] = [];
	for (const url of candidates()) {
		const response = await get(url);
		if (response.status === 404) {
			tried.push(url.href);
			continue;
		}
		return compile(response);
	}
	throw new Error(`sqlite-wasm: sqlite3.wasm not found (looked in ${tried.join(", ")}); pass its URL as the wasm option`);
}

/**
 * Returns a compiled sqlite3.wasm.
 * @param from  where to get it; the package's own file (fetched once and cached) when omitted
 * @param get   the fetch to use; the global one by default
 */
export function load(from?: source, get: fetcher = (url) => fetch(url)): Promise<WebAssembly.Module> {
	if (from === undefined) {
		cached ??= fallback(get).catch((error: unknown) => {
			// Don't cache a failure: a later call may come after the file was deployed or the network came back.
			cached = undefined;
			throw error;
		});
		return cached;
	}
	if (from instanceof WebAssembly.Module) return Promise.resolve(from);
	if (from instanceof Response) return compile(from);
	if (typeof from === "string" || from instanceof URL) return get(new URL(from, globalThis.location?.href)).then(compile);
	return WebAssembly.compile(from as BufferSource);
}

/** The loader as a namespace: `loader.load(from)`. */
const loader = { load, compile, candidates };
export default loader;
