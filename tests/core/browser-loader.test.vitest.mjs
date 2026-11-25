/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/core/browser-loader.test.vitest.mjs
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:16-08:00 (1795642216)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import loader, { candidates, compile, load } from "../../src/core/browser-loader.mts";

const bytes = await readFile(new URL("../../dist/sqlite3.wasm", import.meta.url));
const wasm = (body = bytes, status = 200, type = "application/wasm") => new Response(body, { status, headers: { "content-type": type } });
const isModule = (value) => expect(value).toBeInstanceOf(WebAssembly.Module);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("browser loader", () => {
	it("exposes the same functions on the namespace", () => {
		expect(loader.load).toBe(load);
		expect(loader.compile).toBe(compile);
		expect(loader.candidates).toBe(candidates);
	});

	it("lists the bundle-relative file first, then dist/ from a checkout", () => {
		const [bundled, checkout] = candidates();
		expect(bundled.pathname).toMatch(/\/src\/core\/sqlite3\.wasm$/);
		expect(checkout.pathname).toMatch(/\/dist\/sqlite3\.wasm$/);
	});

	it("passes a compiled module through and compiles bytes", async () => {
		const module = await WebAssembly.compile(bytes);
		expect(await load(module)).toBe(module);
		isModule(await load(bytes));
		isModule(await load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
	});

	it("streams a Response with the wasm MIME type and falls back without it", async () => {
		isModule(await load(wasm()));
		isModule(await load(wasm(bytes, 200, "application/octet-stream")));
	});

	it("compiles without streaming where compileStreaming is missing", async () => {
		const original = WebAssembly.compileStreaming;
		WebAssembly.compileStreaming = undefined;
		try {
			isModule(await compile(wasm()));
		} finally {
			WebAssembly.compileStreaming = original;
		}
	});

	it("rethrows a compile error and an HTTP error", async () => {
		await expect(compile(wasm(new Uint8Array([0, 1, 2, 3])))).rejects.toBeInstanceOf(WebAssembly.CompileError);
		await expect(compile(wasm("nope", 500))).rejects.toThrow(/failed with HTTP 500/);
		const response = wasm("nope", 403);
		Object.defineProperty(response, "url", { value: "https://example.test/x.wasm" });
		await expect(compile(response)).rejects.toThrow("fetching https://example.test/x.wasm failed with HTTP 403");
	});

	it("fetches a URL given as a string or URL, relative to the page", async () => {
		const seen = [];
		const get = async (url) => {
			seen.push(url.href);
			return wasm();
		};
		isModule(await load("https://cdn.test/sqlite3.wasm", get));
		isModule(await load(new URL("https://cdn.test/other.wasm"), get));
		vi.stubGlobal("location", { href: "https://app.test/pages/index.html" });
		isModule(await load("../assets/sqlite3.wasm", get));
		expect(seen).toEqual(["https://cdn.test/sqlite3.wasm", "https://cdn.test/other.wasm", "https://app.test/assets/sqlite3.wasm"]);
		// Without a fetch function the global fetch is used.
		const global = vi.fn(async () => wasm());
		vi.stubGlobal("fetch", global);
		isModule(await load("https://cdn.test/global.wasm"));
		expect(global.mock.calls[0][0].href).toBe("https://cdn.test/global.wasm");
	});

	it("tries the default locations in order, does not cache a failure, then caches the module", async () => {
		const missing = vi.fn(async () => new Response("", { status: 404 }));
		await expect(load(undefined, missing)).rejects.toThrow(/sqlite3\.wasm not found/);
		expect(missing).toHaveBeenCalledTimes(2);

		const get = vi.fn(async (url) => (url.pathname.includes("/src/core/") ? new Response("", { status: 404 }) : wasm()));
		const first = await load(undefined, get);
		isModule(first);
		expect(get).toHaveBeenCalledTimes(2);
		expect(await load()).toBe(first);
		expect(get).toHaveBeenCalledTimes(2);
	});
});
