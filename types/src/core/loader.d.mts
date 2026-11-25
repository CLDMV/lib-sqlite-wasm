/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/loader.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:39:09-08:00 (1795603149)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import { CallbackTable } from "./callbacks.mts";
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
    sqlite3_free(pointer: number): void;
    sqlite3_extended_errcode(db: number): number;
    sqlite3_busy_timeout(db: number, ms: number): number;
    sqlite3_get_autocommit(db: number): number;
    sqlite3_changes64(db: number): bigint;
    sqlite3_last_insert_rowid(db: number): bigint;
    sqlite3_prepare_v3(db: number, sql: number, bytes: number, flags: number, ppStmt: number, pzTail: number): number;
    sqlite3_reset(stmt: number): number;
    sqlite3_sql(stmt: number): number;
    sqlite3_stmt_readonly(stmt: number): number;
    sqlite3_bind_parameter_count(stmt: number): number;
    sqlite3_bind_parameter_name(stmt: number, index: number): number;
    sqlite3_bind_null(stmt: number, index: number): number;
    sqlite3_bind_int64(stmt: number, index: number, value: bigint): number;
    sqlite3_bind_double(stmt: number, index: number, value: number): number;
    sqlite3_bind_text(stmt: number, index: number, text: number, bytes: number, destructor: number): number;
    sqlite3_bind_blob(stmt: number, index: number, data: number, bytes: number, destructor: number): number;
    sqlite3_bind_zeroblob(stmt: number, index: number, bytes: number): number;
    sqlite3_column_decltype(stmt: number, index: number): number;
    sqlite3_column_database_name(stmt: number, index: number): number;
    sqlite3_column_table_name(stmt: number, index: number): number;
    sqlite3_column_origin_name(stmt: number, index: number): number;
    sqlite3_serialize(db: number, schema: number, size: number, flags: number): number;
    sqlite3_backup_init(target: number, targetName: number, source: number, sourceName: number): number;
    sqlite3_backup_step(backup: number, pages: number): number;
    sqlite3_backup_finish(backup: number): number;
    cldmv_create_function(db: number, name: number, argc: number, flags: number, id: number, kind: number): number;
    cldmv_create_collation(db: number, name: number, id: number): number;
    sqlite3_aggregate_context(ctx: number, bytes: number): number;
    sqlite3_value_type(value: number): number;
    sqlite3_value_int64(value: number): bigint;
    sqlite3_value_double(value: number): number;
    sqlite3_value_text(value: number): number;
    sqlite3_value_blob(value: number): number;
    sqlite3_value_bytes(value: number): number;
    sqlite3_result_null(ctx: number): void;
    sqlite3_result_int64(ctx: number, value: bigint): void;
    sqlite3_result_double(ctx: number, value: number): void;
    sqlite3_result_text(ctx: number, text: number, bytes: number, destructor: number): void;
    sqlite3_result_blob(ctx: number, data: number, bytes: number, destructor: number): void;
    sqlite3_result_zeroblob(ctx: number, bytes: number): void;
    sqlite3_result_error(ctx: number, message: number, bytes: number): void;
}
/** A ready-to-use module instance. */
export interface SqliteInstance {
    readonly exports: SqliteExports;
    readonly memory: WasmMemory;
    /** The last exception a VFS driver threw (it was turned into an SQLite error code at the wasm boundary). */
    readonly lastVfsError: unknown;
    /** Returns `lastVfsError` and clears it. */
    takeVfsError(): unknown;
    /** The id -> handler table behind the `env.cb_*` trampoline imports. */
    readonly callbacks: CallbackTable;
}
/** Candidate locations of sqlite3.wasm relative to the module that loads it: the built bundle, then src/core/ in a checkout. */
export declare function wasmCandidates(base: string | URL): URL[];
/** Reads sqlite3.wasm from the first candidate location that exists (Node only). */
export declare function readWasm(base: string | URL): Promise<Uint8Array>;
/** Whether this is Node (and the wasm is read from disk) rather than a browser (where it is fetched). */
export declare function isNode(scope?: {
    process?: {
        versions?: {
            node?: unknown;
        };
    };
}): boolean;
/**
 * Compiles the package's own sqlite3.wasm once and caches the result: read with node:fs in Node, fetched and
 * compiled while it streams in a browser (browser-loader.mts).
 */
export declare function loadSqliteModule(scope?: {
    process?: {
        versions?: {
            node?: unknown;
        };
    };
}): Promise<WebAssembly.Module>;
/**
 * Checks that every import of `module` is one the loader provides, so a module built with an unexpected libc
 * dependency fails here with its name instead of at instantiation with a LinkError.
 */
export declare function checkImports(module: WebAssembly.Module, env: Record<string, unknown>, wasi: Record<string, unknown>): void;
/** Instantiates `module` with `driver` behind the "cldmv" VFS and runs the reactor's initializer. */
export declare function instantiateSqlite(module: WebAssembly.Module, driver: VfsDriver): Promise<SqliteInstance>;
