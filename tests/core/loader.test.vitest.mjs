/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/core/loader.test.vitest.mjs
 *	@Date: 2026-11-25T01:12:49-08:00 (1795597969)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:06-08:00 (1795598286)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkImports, instantiateSqlite, loadSqliteModule, readWasm, wasmCandidates } from "../../src/core/loader.mts";
import { createVfsImports } from "../../src/core/vfs-imports.mts";
import { createWasiImports } from "../../src/core/wasi.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

const encoder = new TextEncoder();

/** A minimal wasm module with one import: kind 0 = function (type `() -> ()`), kind 2 = memory. */
function moduleImporting(from, name, kind = 0) {
	const string = (text) => {
		const bytes = encoder.encode(text);
		return [bytes.length, ...bytes];
	};
	const description = kind === 0 ? [0x00, 0x00] : [0x02, 0x00, 0x01];
	const imports = [0x01, ...string(from), ...string(name), ...description];
	return new WebAssembly.Module(
		new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, imports.length, ...imports])
	);
}

const scratch = new URL(`../../tmp/test-loader-${process.pid}/`, import.meta.url);

beforeAll(() => {
	mkdirSync(new URL("with-dir/sqlite3.wasm/", scratch), { recursive: true });
	mkdirSync(new URL("empty/", scratch), { recursive: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("loader", () => {
	it("looks for sqlite3.wasm next to the bundle, then in dist/ from src/core/", () => {
		const [bundle, checkout] = wasmCandidates("file:///pkg/src/core/loader.mts");
		expect(bundle.pathname).toBe("/pkg/src/core/sqlite3.wasm");
		expect(checkout.pathname).toBe("/pkg/dist/sqlite3.wasm");
	});

	it("explains a missing sqlite3.wasm", async () => {
		await expect(readWasm(new URL("empty/x/y.mjs", scratch))).rejects.toThrow(/sqlite3\.wasm not found .*npm run build:wasm/);
	});

	it("passes on read errors other than a missing file", async () => {
		await expect(readWasm(new URL("with-dir/loader.mjs", scratch))).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("compiles the package's module once", async () => {
		const first = loadSqliteModule();
		expect(loadSqliteModule()).toBe(first);
		expect(await first).toBeInstanceOf(WebAssembly.Module);
	});

	it("imports nothing but the VFS contract and the WASI shims", async () => {
		const module = await loadSqliteModule();
		const imports = WebAssembly.Module.imports(module);
		expect(imports.every(({ kind }) => kind === "function")).toBe(true);
		expect(new Set(imports.map(({ module: from }) => from))).toEqual(new Set(["env", "wasi_snapshot_preview1"]));
		expect(imports.filter(({ module: from }) => from === "wasi_snapshot_preview1").map(({ name }) => name)).toEqual(["random_get"]);
		const env = imports.filter(({ module: from }) => from === "env").map(({ name }) => name);
		expect(env.sort()).toEqual(
			Object.keys(
				createVfsImports(
					new MemoryDriver(),
					() => undefined,
					() => {}
				)
			).sort()
		);
	});

	it("rejects modules with imports it does not provide", () => {
		const env = { vfs_open() {} };
		const wasi = createWasiImports(() => undefined);
		expect(() => checkImports(moduleImporting("env", "vfs_open"), env, wasi)).not.toThrow();
		expect(() => checkImports(moduleImporting("env", "getpid"), env, wasi)).toThrow(
			"sqlite3.wasm imports env.getpid (function), which the loader does not provide"
		);
		expect(() => checkImports(moduleImporting("wasi_snapshot_preview1", "sock_accept"), env, wasi)).toThrow(
			/wasi_snapshot_preview1\.sock_accept/
		);
		expect(() => checkImports(moduleImporting("other", "vfs_open"), env, wasi)).toThrow(/other\.vfs_open/);
		expect(() => checkImports(moduleImporting("env", "vfs_open", 2), env, wasi)).toThrow(/env\.vfs_open \(memory\)/);
	});

	it("instantiates a module with its own memory and driver", async () => {
		const module = await loadSqliteModule();
		const [a, b] = await Promise.all([instantiateSqlite(module, new MemoryDriver()), instantiateSqlite(module, new MemoryDriver())]);
		expect(a.exports.memory).not.toBe(b.exports.memory);
		expect(a.memory.readCString(a.exports.sqlite3_libversion())).toMatch(/^3\.\d+\.\d+$/);
		expect(a.lastVfsError).toBeUndefined();
	});

	it("keeps the last exception a driver threw", async () => {
		const driver = new MemoryDriver();
		const failure = new Error("disk on fire");
		driver.write = () => {
			throw failure;
		};
		const sqlite = await instantiateSqlite(await loadSqliteModule(), driver);
		const { exports, memory } = sqlite;
		const name = memory.allocCString("fire.db");
		const out = memory.alloc(8);
		expect(exports.sqlite3_open_v2(name.pointer, out, 6, 0)).toBe(0);
		const db = memory.view().getUint32(out, true);
		const sql = memory.allocCString("create table t(x)");
		const stmtOut = memory.alloc(8);
		expect(exports.sqlite3_prepare_v2(db, sql.pointer, -1, stmtOut, 0)).toBe(0);
		const stmt = memory.view().getUint32(stmtOut, true);
		expect(exports.sqlite3_step(stmt) & 0xff).toBe(10); // SQLITE_IOERR
		expect(sqlite.lastVfsError).toBe(failure);
		exports.sqlite3_finalize(stmt);
		exports.sqlite3_close_v2(db);
	});
});
