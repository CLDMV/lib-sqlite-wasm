/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: scripts/bump-sqlite.mjs
 *	@Date: 2026-11-25T01:04:03-08:00 (1795597443)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:11-08:00 (1795642211)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Updates sqlite.version.json to the newest pins.
 *
 *   npm run sqlite:bump                 SQLite source archive, from the table sqlite.org embeds in its download page
 *   npm run sqlite:bump -- --toolchain  wasi-sdk and binaryen, from their latest GitHub release (asset digests)
 *   npm run sqlite:bump -- --all        both
 *   npm run sqlite:bump -- --check      report what would change and exit 1 if anything is out of date; write nothing
 *
 * Set GITHUB_TOKEN to avoid the unauthenticated API rate limit. After a bump, run `npm run build:wasm` and the tests;
 * the build cache is keyed on the pins, so the module is rebuilt automatically.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWithRetry } from "./lib/fetch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = path.join(root, "sqlite.version.json");

const DOWNLOAD_PAGE = "https://www.sqlite.org/download.html";
const DOWNLOAD_BASE = "https://www.sqlite.org/";

/** Host key (as in sqlite.version.json) to the platform part of each project's asset name. */
const WASI_PLATFORM = {
	"linux-x64": "x86_64-linux",
	"linux-arm64": "arm64-linux",
	"darwin-x64": "x86_64-macos",
	"darwin-arm64": "arm64-macos"
};
const BINARYEN_PLATFORM = {
	"linux-x64": "x86_64-linux",
	"linux-arm64": "aarch64-linux",
	"darwin-x64": "x86_64-macos",
	"darwin-arm64": "arm64-macos"
};

/**
 * Reads the source archive row (sqlite-src-<n>.zip, what build-wasm generates the amalgamation from) from the CSV that sqlite.org embeds in an HTML comment on its download page
 * (PRODUCT,VERSION,RELATIVE-URL,SIZE-IN-BYTES,SHA3-HASH).
 * @param {string} html
 * @returns {{ version: string, source: { url: string, size: number, sha3_256: string, dir: string } }}
 */
export function parseDownloadPage(html) {
	for (const line of html.split(/\r?\n/)) {
		const [product, version, relative, size, sha3, ...rest] = line.split(",");
		if (product !== "PRODUCT" || rest.length || !/^sqlite-src-\d+\.zip$/.test(path.posix.basename(relative ?? ""))) continue;
		if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/.test(sha3) || !/^\d+$/.test(size)) {
			throw new Error(`bump-sqlite: unexpected source row: ${line}`);
		}
		return {
			version,
			source: {
				url: new URL(relative, DOWNLOAD_BASE).href,
				size: Number(size),
				sha3_256: sha3,
				dir: path.posix.basename(relative, ".zip")
			}
		};
	}
	throw new Error("bump-sqlite: no sqlite-src row in the download page");
}

/**
 * @param {{ assets?: { name: string, digest?: string | null }[] }} release  a GitHub release, as the REST API returns it
 * @param {string} name  asset name
 * @returns {string}  lowercase sha256 hex
 */
function assetSha256(release, name) {
	const asset = release.assets?.find((a) => a.name === name);
	if (!asset) throw new Error(`bump-sqlite: release has no asset ${name}`);
	const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
	if (!match) throw new Error(`bump-sqlite: ${name} has no sha256 digest in the release data`);
	return match[1];
}

/**
 * Builds the wasi-sdk pin for a release (tag `wasi-sdk-34`, assets `wasi-sdk-34.0-x86_64-linux.tar.gz`).
 * @param {{ tag_name: string, assets?: { name: string, digest?: string | null }[] }} release
 */
export function wasiSdkPin(release) {
	const tag = release.tag_name;
	// The asset version ("34.0") is read from the asset names; the tag only carries the major.
	const found = release.assets?.map((a) => /^wasi-sdk-(\d+(?:\.\d+)*)-x86_64-linux\.tar\.gz$/.exec(a.name)).find(Boolean);
	if (!found) throw new Error(`bump-sqlite: ${tag} has no wasi-sdk x86_64-linux asset`);
	const version = found[1];
	const base = `https://github.com/WebAssembly/wasi-sdk/releases/download/${tag}`;
	return { version, tag, assets: pinAssets(release, WASI_PLATFORM, (platform) => `wasi-sdk-${version}-${platform}`, base) };
}

/**
 * Builds the binaryen pin for a release (tag `version_133`, assets `binaryen-version_133-x86_64-linux.tar.gz`).
 * @param {{ tag_name: string, assets?: { name: string, digest?: string | null }[] }} release
 */
export function binaryenPin(release) {
	const tag = release.tag_name;
	const version = /^version_(\d+)$/.exec(tag)?.[1];
	if (!version) throw new Error(`bump-sqlite: unexpected binaryen tag ${tag}`);
	const base = `https://github.com/WebAssembly/binaryen/releases/download/${tag}`;
	return {
		version,
		tag,
		assets: pinAssets(release, BINARYEN_PLATFORM, (platform) => `binaryen-${tag}-${platform}`, base, `binaryen-${tag}`)
	};
}

/**
 * @param {Parameters<typeof assetSha256>[0]} release
 * @param {Record<string, string>} platforms
 * @param {(platform: string) => string} stem  asset name without ".tar.gz"
 * @param {string} base  download URL prefix
 * @param {string} [dir]  fixed directory name inside the archive; defaults to the stem
 */
function pinAssets(release, platforms, stem, base, dir) {
	/** @type {Record<string, { url: string, sha256: string, dir: string }>} */
	const assets = {};
	for (const [key, platform] of Object.entries(platforms)) {
		const name = `${stem(platform)}.tar.gz`;
		assets[key] = { url: `${base}/${name}`, sha256: assetSha256(release, name), dir: dir ?? stem(platform) };
	}
	return assets;
}

/**
 * Applies new pins to a parsed sqlite.version.json (a copy is returned).
 * @param {any} current
 * @param {{ sqlite?: ReturnType<typeof parseDownloadPage>, wasiSdk?: any, binaryen?: any }} next
 * @returns {{ versions: any, changes: string[] }}
 */
export function applyBump(current, next) {
	const versions = structuredClone(current);
	/** @type {string[]} */
	const changes = [];
	if (next.sqlite && JSON.stringify(versions.sqlite.source) !== JSON.stringify(next.sqlite.source)) {
		changes.push(`sqlite ${versions.sqlite.version} -> ${next.sqlite.version}`);
		versions.sqlite = { version: next.sqlite.version, source: next.sqlite.source };
	}
	for (const key of /** @type {const} */ (["wasiSdk", "binaryen"])) {
		if (next[key] && JSON.stringify(versions[key]) !== JSON.stringify(next[key])) {
			changes.push(`${key} ${versions[key].version} -> ${next[key].version}`);
			versions[key] = next[key];
		}
	}
	return { versions, changes };
}

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<string>}
 */
async function fetchText(url, headers) {
	return (await fetchWithRetry(url, { headers })).toString("utf8");
}

/**
 * @param {string[]} argv
 * @param {object} [io]  replaceable for tests
 * @param {string} [io.file]  the version file to read and write
 * @param {typeof fetchText} [io.fetchText]
 * @param {(message: string) => void} [io.out]
 * @returns {Promise<number>}  exit code
 */
export async function main(argv, { file = versionFile, fetchText: get = fetchText, out = console.log } = {}) {
	const flags = new Set(argv);
	const known = new Set(["--toolchain", "--all", "--check"]);
	for (const flag of flags) if (!known.has(flag)) throw new Error(`bump-sqlite: unknown option ${flag} (use --toolchain, --all, --check)`);
	const toolchain = flags.has("--toolchain") || flags.has("--all");
	const sqlite = !flags.has("--toolchain") || flags.has("--all");
	const current = JSON.parse(readFileSync(file, "utf8"));
	const headers = {
		Accept: "application/vnd.github+json",
		...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` })
	};

	/** @type {Parameters<typeof applyBump>[1]} */
	const next = {};
	if (sqlite) next.sqlite = parseDownloadPage(await get(DOWNLOAD_PAGE));
	if (toolchain) {
		const latest = async (/** @type {string} */ repo) =>
			JSON.parse(await get(`https://api.github.com/repos/${repo}/releases/latest`, headers));
		next.wasiSdk = wasiSdkPin(await latest("WebAssembly/wasi-sdk"));
		next.binaryen = binaryenPin(await latest("WebAssembly/binaryen"));
	}
	const { versions, changes } = applyBump(current, next);
	if (!changes.length) {
		out("bump-sqlite: already up to date");
		return 0;
	}
	for (const change of changes) out(`bump-sqlite: ${change}`);
	if (flags.has("--check")) return 1;
	writeFileSync(file, `${JSON.stringify(versions, null, "\t")}\n`);
	out("bump-sqlite: wrote sqlite.version.json; run `npm run build:wasm` and the tests next");
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 2;
	}
}
