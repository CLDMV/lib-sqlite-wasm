/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/connection.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:43:39-08:00 (1795599819)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import type { StorageKind } from "../vfs/registry.mts";
import { error } from "./error.mts";
import type { Runtime } from "./runtime.mts";
import { type value } from "./values.mts";
/** A prepared statement's handle; `pointer` is 0 once it has been finalized. */
export interface StatementState {
    pointer: number;
}
/** One open connection. */
export interface Connection {
    readonly runtime: Runtime;
    /** The sqlite3* handle; 0 once closed. */
    db: number;
    readonly path: string;
    readonly storage: StorageKind;
    readonly readonly: boolean;
    readonly create: boolean;
    readonly timeout: number;
    readonly journal: string;
    readonly bigint: boolean;
    /** The `lock` option as given (attachments and backups reuse it). */
    readonly requested: string;
    /** The lock in effect for the main database ("beside", "temp", a folder, "db", "web" or "none"). */
    readonly lock: string;
    /** Driver options beyond the public ones (the worker host's OPFS root and lock manager), reused by attach and backup. */
    readonly extra: Record<string, unknown>;
    /** Run by `close()` before the connection closes (the "db" lock removes its row). */
    readonly closing: (() => void)[];
    /** Statements that are still prepared, finalized on close. */
    readonly statements: Set<StatementState>;
    /**
     * Router registrations by schema ("main" and attached ones), released on detach and close. Each release resolves
     * once the driver's own (possibly asynchronous) release has finished; it never rejects.
     */
    readonly routes: Map<string, () => Promise<void>>;
    /** Settles when everything `close()` released is released (the worker host waits for it before answering). */
    closed: Promise<void>;
}
/** Throws unless the connection is open; returns its sqlite3* handle. */
export declare function handle(connection: Connection): number;
/**
 * The error for result code `rc` on the connection. SQLite's message is used when it describes `rc`; some failures
 * (API misuse) don't record one, and those get the generic text for the code. An exception a storage driver threw
 * becomes the error's `cause`.
 */
export declare function failure(connection: Connection, rc: number, sql?: string): error;
/**
 * Steps `stmt` once: true for a row, false when done. On failure the statement is reset and the error thrown. If a
 * user function or collation threw during the step, that exception is thrown instead of SQLite's report of it.
 */
export declare function step(connection: Connection, stmt: number, sql: string): boolean;
/** Result of `prepare()`: the statement (0 for an empty one, e.g. only a comment) and the byte offset after it. */
export interface Prepared {
    pointer: number;
    /** Bytes of `sql` consumed. */
    used: number;
}
/** Calls `body` with each statement of `sql` in turn, finalizing it afterwards. */
export declare function each(connection: Connection, sql: string, body: (stmt: number, text: string) => void): void;
/** Runs every statement in `sql`, discarding rows. */
export declare function execute(connection: Connection, sql: string): void;
/** Prepares exactly one statement; `persistent` sets SQLITE_PREPARE_PERSISTENT. */
export declare function prepareOne(connection: Connection, sql: string, persistent: boolean): number;
/** Binds `parameters` to `stmt`, throwing the SQLite error if a bind fails. */
export declare function bind(connection: Connection, stmt: number, parameters: readonly unknown[], sql: string): void;
/** Column names of `stmt`. */
export declare function columnNames(connection: Connection, stmt: number): string[];
/** Runs one internal statement and returns its rows as objects. */
export declare function query(connection: Connection, sql: string, parameters?: readonly unknown[]): Record<string, value>[];
/** Whether the connection is inside a transaction. */
export declare function inTransaction(connection: Connection): boolean;
