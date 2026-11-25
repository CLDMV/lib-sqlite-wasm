/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/raw.mts
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
import { type SqliteInstance } from "./loader.mts";
import type { VfsDriver } from "./vfs-imports.mts";
/** A column value: INTEGER as number (bigint outside the safe range), REAL, TEXT, BLOB or NULL. */
export type RawValue = number | bigint | string | Uint8Array | null;
/** A result row keyed by column name. */
export type RawRow = Record<string, RawValue>;
/** An SQLite error with its (extended) result code. */
export declare class RawSqliteError extends Error {
    readonly errcode: number;
    constructor(message: string, errcode: number);
}
/** Options for `openRaw()`. */
export interface RawOpenOptions {
    /** Storage driver; a new MemoryDriver when omitted. */
    driver?: VfsDriver;
    /** A compiled sqlite3.wasm; the package's own when omitted. */
    module?: WebAssembly.Module;
    /** sqlite3_open_v2 flags; READWRITE | CREATE when omitted. */
    flags?: number;
}
/** An open connection. */
export interface RawDatabase {
    /** The module instance the connection lives in. */
    readonly sqlite: SqliteInstance;
    /** Runs every statement in `sql` and returns the rows of the last one. */
    exec(sql: string): RawRow[];
    /** Closes the connection; later calls are no-ops. */
    close(): void;
}
/** Builds the error for result code `rc` on connection `db` (0 = no connection). */
export declare function sqliteError(sqlite: SqliteInstance, db: number, rc: number): RawSqliteError;
/** Opens `filename` on a fresh module instance. */
export declare function openRaw(filename: string, options?: RawOpenOptions): Promise<RawDatabase>;
