/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/browser-loader.mts
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * @fileoverview Compiles sqlite3.wasm in a browser: fetch plus `WebAssembly.compileStreaming`, so the module compiles
 * while it downloads. The Node loader (loader.mts) reads the file with node:fs instead; both produce a
 * `WebAssembly.Module` for `instantiateSqlite()`.
 *
 * The default location is written as `new URL("./sqlite3.wasm", import.meta.url)` on purpose: Vite, webpack and
 * Parcel recognise that exact pattern and emit the wasm as an asset next to the bundle. When a bundler doesn't, or
 * the file is served from somewhere else, pass its URL (or the bytes, a Response or a compiled module) instead.
 */
/** Anything `load()` can turn into a compiled module. */
export type source = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;
/** The fetch function `load()` uses; injectable for tests. */
export type fetcher = (url: URL) => Promise<Response>;
/** Default locations, in order: next to the bundle, then dist/ from src/core/ in a checkout. */
export declare function candidates(): URL[];
/** Compiles a fetched response, streaming when the server sends the wasm MIME type. */
export declare function compile(response: Response): Promise<WebAssembly.Module>;
/**
 * Returns a compiled sqlite3.wasm.
 * @param from  where to get it; the package's own file (fetched once and cached) when omitted
 * @param get   the fetch to use; the global one by default
 */
export declare function load(from?: source, get?: fetcher): Promise<WebAssembly.Module>;
/** The loader as a namespace: `loader.load(from)`. */
declare const loader: {
    load: typeof load;
    compile: typeof compile;
    candidates: typeof candidates;
};
export default loader;
