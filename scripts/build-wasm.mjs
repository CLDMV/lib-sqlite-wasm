/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /scripts/build-wasm.mjs
 *	@Date: 2026-11-25T01:04:03-08:00 (1795597443)
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
 * @fileoverview Builds dist/sqlite3.wasm from source.
 *
 * Steps, all driven from sqlite.version.json:
 *   1. Download the SQLite amalgamation (verified against its SHA3-256) and extract sqlite3.c / sqlite3.h.
 *   2. Download wasi-sdk (clang + wasi-libc) and binaryen (wasm-opt) for this host, verified against their SHA-256.
 *   3. Compile sqlite3.c + src/c/glue.c with clang for wasm32-wasip1 (-O3 -flto, reactor module, no emscripten).
 *   4. Run wasm-opt and write dist/sqlite3.wasm.
 *
 * Downloads and tool trees live in SQLITE_WASM_TOOLCHAIN_DIR (default .cache/toolchains/). The linked module is also
 * cached under .cache/build/, keyed by everything that goes into it, so a second `npm run build` in the same checkout
 * only copies it back into dist/ (tsup cleans dist/ first).
 *
 * No shell is used: every tool runs through spawnSync with an argument array. `tar` must be on PATH (it is on Linux,
 * macOS and the CI runner image); the zip is read with node:zlib.
 *
 * Usage: node scripts/build-wasm.mjs [--force]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";
import { fetchWithRetry } from "./lib/fetch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versions = JSON.parse(readFileSync(path.join(root, "sqlite.version.json"), "utf8"));
const toolchainDir = path.resolve(root, process.env.SQLITE_WASM_TOOLCHAIN_DIR || ".cache/toolchains");
const buildCacheDir = path.join(root, ".cache", "build");
const force = process.argv.includes("--force");

/**
 * SQLite compile-time options (https://www.sqlite.org/compile.html). Each name was checked against that page and
 * against the amalgamation's own sqlite3azCompileOpt[] list. FTS4 comes from SQLITE_ENABLE_FTS3 (the amalgamation
 * builds FTS3 and FTS4 together); JSON is built in by default since 3.38.
 */
export const SQLITE_DEFINES = [
	// Features
	"SQLITE_ENABLE_FTS3",
	"SQLITE_ENABLE_FTS3_PARENTHESIS",
	"SQLITE_ENABLE_FTS5",
	"SQLITE_ENABLE_RTREE",
	"SQLITE_ENABLE_GEOPOLY",
	"SQLITE_ENABLE_DBSTAT_VTAB",
	"SQLITE_ENABLE_MATH_FUNCTIONS",
	"SQLITE_ENABLE_COLUMN_METADATA",
	"SQLITE_ENABLE_STAT4",
	// Not SQLITE_ENABLE_UPDATE_DELETE_LIMIT: it needs a parser regenerated with Lemon, and the amalgamation ships a
	// parser built without it (setting the define only adds the name to compile_options; the syntax stays an error).
	"SQLITE_ENABLE_PERCENTILE",
	// Defaults
	"SQLITE_DEFAULT_FOREIGN_KEYS=1",
	"SQLITE_DEFAULT_MEMSTATUS=0",
	"SQLITE_DQS=0",
	"SQLITE_TEMP_STORE=3",
	"SQLITE_DEFAULT_WAL_SYNCHRONOUS=1",
	"SQLITE_LIKE_DOESNT_MATCH_BLOBS",
	"SQLITE_THREADSAFE=0",
	"SQLITE_OS_OTHER=1",
	// Omitted
	"SQLITE_OMIT_LOAD_EXTENSION",
	"SQLITE_OMIT_UTF16",
	"SQLITE_OMIT_SHARED_CACHE",
	"SQLITE_OMIT_DEPRECATED",
	"SQLITE_OMIT_PROGRESS_CALLBACK",
	"SQLITE_OMIT_TCL_VARIABLE",
	"SQLITE_OMIT_GET_TABLE"
];

/** Functions the module exports (besides `memory` and the reactor's `_initialize`). */
export const EXPORTS = [
	"malloc",
	"free",
	"sqlite3_malloc",
	"sqlite3_free",
	"sqlite3_libversion",
	"sqlite3_libversion_number",
	"sqlite3_sourceid",
	"sqlite3_compileoption_used",
	"sqlite3_compileoption_get",
	"sqlite3_open_v2",
	"sqlite3_close_v2",
	"sqlite3_db_filename",
	"sqlite3_errcode",
	"sqlite3_extended_errcode",
	"sqlite3_extended_result_codes",
	"sqlite3_errmsg",
	"sqlite3_errstr",
	"sqlite3_busy_timeout",
	"sqlite3_interrupt",
	"sqlite3_limit",
	"sqlite3_get_autocommit",
	"sqlite3_changes64",
	"sqlite3_total_changes64",
	"sqlite3_last_insert_rowid",
	"sqlite3_prepare_v2",
	"sqlite3_prepare_v3",
	"sqlite3_step",
	"sqlite3_reset",
	"sqlite3_finalize",
	"sqlite3_sql",
	"sqlite3_expanded_sql",
	"sqlite3_stmt_readonly",
	"sqlite3_stmt_busy",
	"sqlite3_clear_bindings",
	"sqlite3_bind_parameter_count",
	"sqlite3_bind_parameter_index",
	"sqlite3_bind_parameter_name",
	"sqlite3_bind_null",
	"sqlite3_bind_int",
	"sqlite3_bind_int64",
	"sqlite3_bind_double",
	"sqlite3_bind_text",
	"sqlite3_bind_blob",
	"sqlite3_bind_zeroblob",
	"sqlite3_column_count",
	"sqlite3_data_count",
	"sqlite3_column_name",
	"sqlite3_column_decltype",
	"sqlite3_column_database_name",
	"sqlite3_column_table_name",
	"sqlite3_column_origin_name",
	"sqlite3_column_type",
	"sqlite3_column_int64",
	"sqlite3_column_double",
	"sqlite3_column_text",
	"sqlite3_column_blob",
	"sqlite3_column_bytes",
	"sqlite3_serialize",
	"sqlite3_deserialize"
];

/** clang flags shared by compile and link. */
const CFLAGS = ["--target=wasm32-wasip1", "-O3", "-flto", "-DNDEBUG", "-Wno-unused-command-line-argument"];

/** Linker flags (passed through clang). */
const LDFLAGS = [
	// A reactor has no main(); it exports _initialize, which runs the C constructors once after instantiation.
	"-mexec-model=reactor",
	"-Wl,-z,stack-size=1048576",
	"-Wl,--strip-debug",
	...EXPORTS.map((name) => `-Wl,--export=${name}`)
];

/** wasm-opt flags. Features are read from the module's target_features section, then that section is stripped. */
const WASM_OPT_FLAGS = ["-O3", "--strip-debug", "--strip-producers", "--strip-target-features"];

/**
 * @param {string} message
 */
function log(message) {
	process.stdout.write(`build-wasm: ${message}\n`);
}

/**
 * @returns {string} The sqlite.version.json asset key for this host.
 */
function hostKey() {
	const os = { linux: "linux", darwin: "darwin" }[process.platform];
	const arch = { x64: "x64", arm64: "arm64" }[process.arch];
	if (!os || !arch) {
		throw new Error(
			`build-wasm: no pinned toolchain for ${process.platform}-${process.arch} (supported: linux and darwin, x64 and arm64). ` +
				"The published package ships a prebuilt dist/sqlite3.wasm, so only contributors building from source need this; use WSL or a Linux container on Windows."
		);
	}
	return `${os}-${arch}`;
}

/**
 * @param {string} algorithm
 * @param {Buffer} data
 */
function digest(algorithm, data) {
	return createHash(algorithm).update(data).digest("hex");
}

/**
 * Downloads `url` to `file` unless a copy with the expected hash is already there.
 * @param {string} url
 * @param {string} file
 * @param {string} algorithm  node:crypto hash name ("sha3-256", "sha256")
 * @param {string} expected   lowercase hex digest
 */
async function download(url, file, algorithm, expected) {
	if (existsSync(file) && digest(algorithm, readFileSync(file)) === expected) return;
	const data = await fetchWithRetry(url, { log });
	const actual = digest(algorithm, data);
	if (actual !== expected) throw new Error(`build-wasm: ${url}: ${algorithm} mismatch (expected ${expected}, got ${actual})`);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(`${file}.part`, data);
	renameSync(`${file}.part`, file);
}

/**
 * Extracts named entries from a zip archive (stored or deflated entries only, which is all sqlite.org ships).
 * @param {Buffer} zip
 * @param {string[]} names  entry paths inside the archive
 * @returns {Map<string, Buffer>}
 */
function unzip(zip, names) {
	const wanted = new Set(names);
	const found = new Map();
	// End of central directory record: signature 0x06054b50, searched backwards past a possible comment.
	let eocd = zip.length - 22;
	while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error("build-wasm: not a zip archive");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("build-wasm: corrupt zip central directory");
		const method = zip.readUInt16LE(at + 10);
		const compressedSize = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const localHeader = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;
		if (!wanted.has(name)) continue;
		const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
		const raw = zip.subarray(dataStart, dataStart + compressedSize);
		if (method === 0) found.set(name, Buffer.from(raw));
		else if (method === 8) found.set(name, inflateRawSync(raw));
		else throw new Error(`build-wasm: ${name}: unsupported zip method ${method}`);
	}
	for (const name of wanted) if (!found.has(name)) throw new Error(`build-wasm: ${name} missing from the amalgamation zip`);
	return found;
}

/**
 * Runs a tool, streaming its output; throws on a non-zero exit.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`build-wasm: ${path.basename(command)} exited with ${result.status ?? result.signal}`);
}

/**
 * Downloads and unpacks a pinned .tar.gz toolchain once; returns its root directory.
 * @param {string} name  "wasi-sdk" or "binaryen"
 * @param {{ version: string, assets: Record<string, { url: string, sha256: string, dir: string }> }} pin
 */
async function toolchain(name, pin) {
	const asset = pin.assets[hostKey()];
	if (!asset) throw new Error(`build-wasm: no pinned ${name} for ${hostKey()}`);
	const home = path.join(toolchainDir, `${name}-${pin.version}-${hostKey()}`);
	const marker = path.join(home, ".complete");
	if (existsSync(marker) && readFileSync(marker, "utf8") === asset.sha256) return path.join(home, asset.dir);
	const archive = path.join(toolchainDir, "downloads", path.basename(new URL(asset.url).pathname));
	await download(asset.url, archive, "sha256", asset.sha256);
	log(`extracting ${path.basename(archive)}`);
	rmSync(home, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });
	run("tar", ["-xzf", archive, "-C", home]);
	if (!existsSync(path.join(home, asset.dir))) throw new Error(`build-wasm: ${archive} has no ${asset.dir}/ directory`);
	writeFileSync(marker, asset.sha256);
	return path.join(home, asset.dir);
}

/** Downloads and extracts the amalgamation; returns the directory holding sqlite3.c and sqlite3.h. */
async function amalgamation() {
	const { version, amalgamation: pin } = versions.sqlite;
	const dir = path.join(toolchainDir, `sqlite-${version}`);
	const marker = path.join(dir, ".complete");
	if (existsSync(marker) && readFileSync(marker, "utf8") === pin.sha3_256) return dir;
	const archive = path.join(toolchainDir, "downloads", path.basename(new URL(pin.url).pathname));
	await download(pin.url, archive, "sha3-256", pin.sha3_256);
	const files = unzip(readFileSync(archive), [`${pin.dir}/sqlite3.c`, `${pin.dir}/sqlite3.h`]);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [name, data] of files) writeFileSync(path.join(dir, path.basename(name)), data);
	writeFileSync(marker, pin.sha3_256);
	return dir;
}

async function main() {
	const started = performance.now();
	const glue = path.join(root, "src", "c", "glue.c");
	const out = path.join(root, "dist", "sqlite3.wasm");
	const key = digest(
		"sha256",
		Buffer.from(
			JSON.stringify({
				versions,
				glue: digest("sha256", readFileSync(glue)),
				SQLITE_DEFINES,
				EXPORTS,
				CFLAGS,
				LDFLAGS,
				WASM_OPT_FLAGS
			})
		)
	).slice(0, 16);
	const cached = path.join(buildCacheDir, `sqlite3-${key}.wasm`);
	mkdirSync(path.dirname(out), { recursive: true });

	if (!force && existsSync(cached)) {
		copyFileSync(cached, out);
		log(`dist/sqlite3.wasm from cache (${key})`);
		return;
	}

	const [sqliteDir, wasiSdk, binaryen] = await Promise.all([
		amalgamation(),
		toolchain("wasi-sdk", versions.wasiSdk),
		toolchain("binaryen", versions.binaryen)
	]);
	const fetched = performance.now();

	const work = path.join(buildCacheDir, `work-${key}`);
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	const linked = path.join(work, "sqlite3.linked.wasm");
	const clang = path.join(wasiSdk, "bin", "clang");
	const args = [
		...CFLAGS,
		`--sysroot=${path.join(wasiSdk, "share", "wasi-sysroot")}`,
		`-I${sqliteDir}`,
		...SQLITE_DEFINES.map((d) => `-D${d}`),
		path.join(sqliteDir, "sqlite3.c"),
		glue,
		...LDFLAGS,
		"-o",
		linked
	];
	log(`clang ${args.join(" ")}`);
	run(clang, args);
	const compiled = performance.now();

	const optimized = path.join(work, "sqlite3.wasm");
	run(path.join(binaryen, "bin", "wasm-opt"), [...WASM_OPT_FLAGS, linked, "-o", optimized]);
	const optimizedAt = performance.now();

	const linkedSize = statSync(linked).size;
	copyFileSync(optimized, cached);
	copyFileSync(optimized, out);
	rmSync(work, { recursive: true, force: true });

	const bytes = readFileSync(out);
	const seconds = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)}s`;
	log(`linked module: ${linkedSize} bytes before wasm-opt`);
	log(
		`dist/sqlite3.wasm: ${bytes.length} bytes, ${gzipSync(bytes, { level: 9 }).length} gzipped; ` +
			`fetch ${seconds(fetched - started)}, compile+link ${seconds(compiled - fetched)}, wasm-opt ${seconds(optimizedAt - compiled)}, ` +
			`total ${seconds(optimizedAt - started)}`
	);
}

await main();
