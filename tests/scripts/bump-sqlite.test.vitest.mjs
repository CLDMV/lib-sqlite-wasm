/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/scripts/bump-sqlite.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:17-08:00 (1795642217)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Tests for scripts/bump-sqlite.mjs and scripts/lib/fetch.mjs, against fixture data (no network).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applyBump, binaryenPin, main, parseDownloadPage, wasiSdkPin } from "../../scripts/bump-sqlite.mjs";
import { fetchWithRetry } from "../../scripts/lib/fetch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const page = readFileSync(path.join(here, "download-page.fixture.txt"), "utf8");
const current = JSON.parse(readFileSync(path.join(root, "sqlite.version.json"), "utf8"));

const sha = (/** @type {string} */ c) => c.repeat(64);
/** A GitHub release payload with a digest for every asset name given. */
const release = (/** @type {string} */ tag, /** @type {string[]} */ names) => ({
	tag_name: tag,
	assets: names.map((name, i) => ({ name, digest: `sha256:${sha("abcdef"[i % 6])}` }))
});
const wasiRelease = release("wasi-sdk-35", [
	"wasi-sdk-35.0-x86_64-linux.tar.gz",
	"wasi-sdk-35.0-arm64-linux.tar.gz",
	"wasi-sdk-35.0-x86_64-macos.tar.gz",
	"wasi-sdk-35.0-arm64-macos.tar.gz",
	"wasi-sdk-35.0-x86_64-linux.deb"
]);
const binaryenRelease = release("version_134", [
	"binaryen-version_134-x86_64-linux.tar.gz",
	"binaryen-version_134-aarch64-linux.tar.gz",
	"binaryen-version_134-x86_64-macos.tar.gz",
	"binaryen-version_134-arm64-macos.tar.gz",
	"binaryen-version_134-x86_64-linux.tar.gz.sha256"
]);

describe("parseDownloadPage", () => {
	it("reads the source archive row from the embedded CSV", () => {
		expect(parseDownloadPage(page)).toEqual({ version: current.sqlite.version, source: current.sqlite.source });
	});

	it("rejects a page with no source archive row", () => {
		expect(() => parseDownloadPage("<html>nothing</html>")).toThrow(/no sqlite-src row/);
	});

	it("rejects a malformed row", () => {
		const bad = "PRODUCT,3.54.1,2026/sqlite-src-3540100.zip,14899528,nothex";
		expect(() => parseDownloadPage(bad)).toThrow(/unexpected source row/);
	});
});

describe("toolchain pins", () => {
	it("builds the wasi-sdk pin from release assets and digests", () => {
		const pin = wasiSdkPin(wasiRelease);
		expect(pin.version).toBe("35.0");
		expect(pin.tag).toBe("wasi-sdk-35");
		expect(Object.keys(pin.assets)).toEqual(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);
		expect(pin.assets["linux-x64"]).toEqual({
			url: "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-35/wasi-sdk-35.0-x86_64-linux.tar.gz",
			sha256: sha("a"),
			dir: "wasi-sdk-35.0-x86_64-linux"
		});
		expect(pin.assets["darwin-arm64"].dir).toBe("wasi-sdk-35.0-arm64-macos");
	});

	it("builds the binaryen pin, with one shared directory name", () => {
		const pin = binaryenPin(binaryenRelease);
		expect(pin.version).toBe("134");
		expect(pin.assets["linux-arm64"].url).toBe(
			"https://github.com/WebAssembly/binaryen/releases/download/version_134/binaryen-version_134-aarch64-linux.tar.gz"
		);
		expect(new Set(Object.values(pin.assets).map((a) => a.dir))).toEqual(new Set(["binaryen-version_134"]));
	});

	it("matches the shape of the pins already in sqlite.version.json", () => {
		// The pin builders must reproduce today's file from today's release data, so a bump only changes values.
		for (const [key, pin] of [
			["wasiSdk", wasiSdkPin(wasiRelease)],
			["binaryen", binaryenPin(binaryenRelease)]
		]) {
			expect(Object.keys(pin)).toEqual(Object.keys(current[key]));
			expect(Object.keys(pin.assets)).toEqual(Object.keys(current[key].assets));
			expect(Object.keys(pin.assets["linux-x64"])).toEqual(Object.keys(current[key].assets["linux-x64"]));
		}
	});

	it("fails when a platform asset is missing", () => {
		expect(() => wasiSdkPin(release("wasi-sdk-35", ["wasi-sdk-35.0-x86_64-linux.tar.gz"]))).toThrow(/no asset wasi-sdk-35.0-arm64-linux/);
	});

	it("fails when an asset has no sha256 digest", () => {
		const noDigest = { tag_name: "version_134", assets: binaryenRelease.assets.map((a) => ({ name: a.name, digest: null })) };
		expect(() => binaryenPin(noDigest)).toThrow(/no sha256 digest/);
	});

	it("fails on a tag or release it does not recognise", () => {
		expect(() => binaryenPin(release("nightly", []))).toThrow(/unexpected binaryen tag/);
		expect(() => wasiSdkPin(release("wasi-sdk-35", []))).toThrow(/no wasi-sdk x86_64-linux asset/);
	});
});

describe("applyBump", () => {
	it("reports no change when the pins already match", () => {
		const { versions, changes } = applyBump(current, { sqlite: parseDownloadPage(page) });
		expect(changes).toEqual([]);
		expect(versions).toEqual(current);
	});

	it("replaces the sqlite pin and leaves the toolchain alone", () => {
		const row = "PRODUCT,3.55.0,2027/sqlite-src-3550000.zip,3000000," + sha("1");
		const { versions, changes } = applyBump(current, { sqlite: parseDownloadPage(row) });
		expect(changes).toEqual([`sqlite ${current.sqlite.version} -> 3.55.0`]);
		expect(versions.sqlite.source).toEqual({
			url: "https://www.sqlite.org/2027/sqlite-src-3550000.zip",
			size: 3000000,
			sha3_256: sha("1"),
			dir: "sqlite-src-3550000"
		});
		expect(versions.wasiSdk).toEqual(current.wasiSdk);
		expect(current.sqlite.version).toBe("3.54.1");
	});

	it("replaces the toolchain pins", () => {
		const { versions, changes } = applyBump(current, { wasiSdk: wasiSdkPin(wasiRelease), binaryen: binaryenPin(binaryenRelease) });
		expect(changes).toEqual([`wasiSdk ${current.wasiSdk.version} -> 35.0`, `binaryen ${current.binaryen.version} -> 134`]);
		expect(versions.sqlite).toEqual(current.sqlite);
	});
});

describe("fetchWithRetry", () => {
	const ok = (/** @type {string} */ text) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(text) });
	const status = (/** @type {number} */ code) => ({ ok: false, status: code });

	it("returns the body of a successful response", async () => {
		const fetch = vi.fn().mockResolvedValue(ok("hello"));
		expect((await fetchWithRetry("https://x/y", { fetch })).toString()).toBe("hello");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("retries a 503 and a network error with doubling backoff, then succeeds", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(status(503)).mockRejectedValueOnce(new Error("reset")).mockResolvedValue(ok("done"));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const log = vi.fn();
		expect((await fetchWithRetry("https://x/y", { fetch, sleep, log })).toString()).toBe("done");
		expect(sleep.mock.calls).toEqual([[2000], [4000]]);
		expect(log).toHaveBeenLastCalledWith("downloading https://x/y (attempt 3/5)");
	});

	it("retries a 429", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValue(ok("x"));
		await fetchWithRetry("https://x/y", { fetch, sleep: async () => {} });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("fails at once on a 404", async () => {
		const fetch = vi.fn().mockResolvedValue(status(404));
		await expect(fetchWithRetry("https://x/y", { fetch, sleep: async () => {} })).rejects.toThrow("https://x/y: HTTP 404");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("gives up after five attempts and names the last error and its cause", async () => {
		const error = new Error("fetch failed", { cause: new Error("ECONNRESET") });
		const fetch = vi.fn().mockRejectedValue(error);
		await expect(fetchWithRetry("https://x/y", { fetch, sleep: async () => {} })).rejects.toThrow("fetch failed (ECONNRESET)");
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it("reports a thrown non-Error value", async () => {
		const fetch = vi.fn().mockRejectedValue("boom");
		await expect(fetchWithRetry("https://x/y", { fetch, sleep: async () => {} })).rejects.toThrow("https://x/y: boom");
	});

	it("passes request headers through", async () => {
		const fetch = vi.fn().mockResolvedValue(ok("x"));
		await fetchWithRetry("https://x/y", { fetch, headers: { Accept: "a" } });
		expect(fetch.mock.calls[0][1].headers).toEqual({ Accept: "a" });
	});

	it("uses the global fetch and a real timer sleep by default", async () => {
		vi.useFakeTimers();
		try {
			const global = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(/** @type {any} */ (status(500)))
				.mockResolvedValue(/** @type {any} */ (ok("g")));
			const pending = fetchWithRetry("https://x/y");
			await vi.advanceTimersByTimeAsync(2000);
			expect((await pending).toString()).toBe("g");
			global.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("main", () => {
	const newPage = "PRODUCT,3.55.0,2027/sqlite-src-3550000.zip,3000000," + sha("1");
	const scratch = path.join(root, "tmp", "agents", "ci", "bump-test");

	/** A scratch copy of the version file plus a fake network keyed by URL. */
	function setup(/** @type {Record<string, string>} */ pages) {
		mkdirSync(scratch, { recursive: true });
		const file = path.join(scratch, "sqlite.version.json");
		writeFileSync(file, JSON.stringify(current));
		const requested = /** @type {string[]} */ ([]);
		const fetchText = async (/** @type {string} */ url) => {
			requested.push(url);
			if (!(url in pages)) throw new Error(`unexpected request ${url}`);
			return pages[url];
		};
		const lines = /** @type {string[]} */ ([]);
		return { file, fetchText, out: (/** @type {string} */ m) => lines.push(m), lines, requested };
	}

	const github = {
		"https://api.github.com/repos/WebAssembly/wasi-sdk/releases/latest": JSON.stringify(wasiRelease),
		"https://api.github.com/repos/WebAssembly/binaryen/releases/latest": JSON.stringify(binaryenRelease)
	};

	it("writes a new sqlite pin", async () => {
		const io = setup({ "https://www.sqlite.org/download.html": newPage });
		try {
			expect(await main([], io)).toBe(0);
			const written = readFileSync(io.file, "utf8");
			expect(written.endsWith("}\n")).toBe(true);
			expect(JSON.parse(written).sqlite.version).toBe("3.55.0");
			expect(JSON.parse(written).wasiSdk).toEqual(current.wasiSdk);
			expect(io.requested).toEqual(["https://www.sqlite.org/download.html"]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("writes nothing and exits 1 with --check when a pin is out of date", async () => {
		const io = setup({ "https://www.sqlite.org/download.html": newPage });
		try {
			expect(await main(["--check"], io)).toBe(1);
			expect(JSON.parse(readFileSync(io.file, "utf8"))).toEqual(current);
			expect(io.lines).toEqual([`bump-sqlite: sqlite ${current.sqlite.version} -> 3.55.0`]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("exits 0 and says so when nothing changed", async () => {
		const io = setup({ "https://www.sqlite.org/download.html": page });
		try {
			expect(await main(["--check"], io)).toBe(0);
			expect(io.lines).toEqual(["bump-sqlite: already up to date"]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("bumps only the toolchain with --toolchain", async () => {
		const io = setup(github);
		try {
			expect(await main(["--toolchain"], io)).toBe(0);
			const written = JSON.parse(readFileSync(io.file, "utf8"));
			expect(written.sqlite).toEqual(current.sqlite);
			expect(written.wasiSdk.version).toBe("35.0");
			expect(written.binaryen.version).toBe("134");
			expect(io.requested).not.toContain("https://www.sqlite.org/download.html");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("bumps everything with --all, sending the GitHub token when one is set", async () => {
		const io = setup({ "https://www.sqlite.org/download.html": newPage, ...github });
		const seen = /** @type {Record<string, string>[]} */ ([]);
		const spy = async (/** @type {string} */ url, /** @type {Record<string, string> | undefined} */ headers) => {
			if (headers) seen.push(headers);
			return io.fetchText(url);
		};
		vi.stubEnv("GITHUB_TOKEN", "t0ken");
		try {
			expect(await main(["--all"], { ...io, fetchText: spy })).toBe(0);
			expect(io.lines).toHaveLength(4);
			expect(seen.map((h) => h.Authorization)).toEqual(["Bearer t0ken", "Bearer t0ken"]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("rejects an unknown option", async () => {
		await expect(main(["--nope"])).rejects.toThrow(/unknown option --nope/);
	});
});
