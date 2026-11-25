/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/loader.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:15-08:00 (1795598295)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * @fileoverview Compiles and instantiates sqlite3.wasm.
 *
 * Nothing happens at import time: the package is also loaded through a require(esm) CJS wrapper, which cannot wait
 * for top-level await. The module is compiled on the first call to `loadSqliteModule()` and that promise is cached;
 * each `instantiateSqlite()` call then makes a fresh instance (its own memory and its own VFS driver).
 */
import { WasmMemory } from "./memory.mts";
import { type VfsDriver } from "./vfs-imports.mts";
/** The functions sqlite3.wasm exports (see EXPORTS in scripts/build-wasm.mjs). Pointers are wasm32 numbers; i64 values are bigint. */
export interface SqliteExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    malloc(size: number): number;
    free(pointer: number): void;
    sqlite3_libversion(): number;
    sqlite3_libversion_number(): number;
    sqlite3_open_v2(filename: number, ppDb: number, flags: number, vfs: number): number;
    sqlite3_close_v2(db: number): number;
    sqlite3_extended_result_codes(db: number, onoff: number): number;
    sqlite3_errmsg(db: number): number;
    sqlite3_errstr(rc: number): number;
    sqlite3_prepare_v2(db: number, sql: number, bytes: number, ppStmt: number, pzTail: number): number;
    sqlite3_step(stmt: number): number;
    sqlite3_finalize(stmt: number): number;
    sqlite3_column_count(stmt: number): number;
    sqlite3_column_name(stmt: number, index: number): number;
    sqlite3_column_type(stmt: number, index: number): number;
    sqlite3_column_int64(stmt: number, index: number): bigint;
    sqlite3_column_double(stmt: number, index: number): number;
    sqlite3_column_text(stmt: number, index: number): number;
    sqlite3_column_blob(stmt: number, index: number): number;
    sqlite3_column_bytes(stmt: number, index: number): number;
}
/** A ready-to-use module instance. */
export interface SqliteInstance {
    readonly exports: SqliteExports;
    readonly memory: WasmMemory;
    /** The last exception a VFS driver threw (it was turned into an SQLite error code at the wasm boundary). */
    readonly lastVfsError: unknown;
}
/** Candidate locations of sqlite3.wasm relative to the module that loads it: the built bundle, then src/core/ in a checkout. */
export declare function wasmCandidates(base: string | URL): URL[];
/** Reads sqlite3.wasm from the first candidate location that exists (Node only). */
export declare function readWasm(base: string | URL): Promise<Uint8Array>;
/** Compiles the package's own sqlite3.wasm once and caches the result. */
export declare function loadSqliteModule(): Promise<WebAssembly.Module>;
/**
 * Checks that every import of `module` is one the loader provides, so a module built with an unexpected libc
 * dependency fails here with its name instead of at instantiation with a LinkError.
 */
export declare function checkImports(module: WebAssembly.Module, env: Record<string, unknown>, wasi: Record<string, unknown>): void;
/** Instantiates `module` with `driver` behind the "cldmv" VFS and runs the reactor's initializer. */
export declare function instantiateSqlite(module: WebAssembly.Module, driver: VfsDriver): Promise<SqliteInstance>;
