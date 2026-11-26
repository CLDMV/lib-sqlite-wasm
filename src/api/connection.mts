/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/api/connection.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
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
 * @fileoverview The state behind one `database` object, and the low-level operations the API modules share:
 * preparing, stepping, building errors and running internal SQL.
 */
import { SQLITE_DONE, SQLITE_MISUSE, SQLITE_OK, SQLITE_ROW } from "../core/constants.mts";
import type { StorageKind } from "../vfs/registry.mts";
import { error } from "./error.mts";
import type { Runtime } from "./runtime.mts";
import { bindAll, columnValue, type value } from "./values.mts";

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
export function handle(connection: Connection): number {
	if (connection.db === 0) throw new error("database is closed", SQLITE_MISUSE);
	return connection.db;
}

/**
 * The error for result code `rc` on the connection. SQLite's message is used when it describes `rc`; some failures
 * (API misuse) don't record one, and those get the generic text for the code. An exception a storage driver threw
 * becomes the error's `cause`.
 */
export function failure(connection: Connection, rc: number, sql?: string): error {
	const { exports, memory } = connection.runtime.instance;
	const recorded = exports.sqlite3_extended_errcode(connection.db) === rc;
	const message = memory.readCString(recorded ? exports.sqlite3_errmsg(connection.db) : exports.sqlite3_errstr(rc)) as string;
	const cause = connection.runtime.instance.takeVfsError();
	return new error(message, rc, sql, cause === undefined ? undefined : { cause });
}

/**
 * Steps `stmt` once: true for a row, false when done. On failure the statement is reset and the error thrown. If a
 * user function or collation threw during the step, that exception is thrown instead of SQLite's report of it.
 */
export function step(connection: Connection, stmt: number, sql: string): boolean {
	const { runtime } = connection;
	const { exports } = runtime.instance;
	runtime.pending = undefined;
	runtime.instance.takeVfsError();
	const rc = exports.sqlite3_step(stmt);
	// Callbacks set this during the step; TypeScript can't see that and would narrow it to undefined.
	const pending = runtime.pending as Runtime["pending"];
	runtime.pending = undefined;
	if (pending || (rc !== SQLITE_ROW && rc !== SQLITE_DONE)) {
		const thrown = pending ? pending.error : failure(connection, rc, sql);
		exports.sqlite3_reset(stmt);
		throw thrown;
	}
	return rc === SQLITE_ROW;
}

/** Result of `prepare()`: the statement (0 for an empty one, e.g. only a comment) and the byte offset after it. */
export interface Prepared {
	pointer: number;
	/** Bytes of `sql` consumed. */
	used: number;
}

/**
 * Compiles the first statement in `bytes` bytes of UTF-8 at `text`. `flags` are sqlite3_prepare_v3 flags.
 * Throws the SQLite error with `sql` attached.
 */
function compile(connection: Connection, text: number, bytes: number, flags: number, sql: string): Prepared {
	const { exports, memory } = connection.runtime.instance;
	const out = memory.alloc(8);
	try {
		const rc = exports.sqlite3_prepare_v3(handle(connection), text, bytes, flags, out, out + 4);
		if (rc !== SQLITE_OK) throw failure(connection, rc, sql);
		return { pointer: memory.view().getUint32(out, true), used: memory.view().getUint32(out + 4, true) - text };
	} finally {
		memory.free(out);
	}
}

/** Calls `body` with each statement of `sql` in turn, finalizing it afterwards. */
export function each(connection: Connection, sql: string, body: (stmt: number, text: string) => void): void {
	const { exports, memory } = connection.runtime.instance;
	const text = memory.allocCString(sql);
	try {
		let offset = 0;
		while (offset < text.length) {
			const { pointer, used } = compile(connection, text.pointer + offset, text.length - offset, 0, sql);
			const statement = memory.readUtf8(text.pointer + offset, used).trim();
			offset += used;
			// Whitespace or a comment at the end compiles to no statement.
			if (pointer === 0) continue;
			try {
				body(pointer, statement);
			} finally {
				exports.sqlite3_finalize(pointer);
			}
		}
	} finally {
		memory.free(text.pointer);
	}
}

/** Runs every statement in `sql`, discarding rows. */
export function execute(connection: Connection, sql: string): void {
	each(connection, sql, (stmt, text) => {
		while (step(connection, stmt, text));
	});
}

/** Prepares exactly one statement; `persistent` sets SQLITE_PREPARE_PERSISTENT. */
export function prepareOne(connection: Connection, sql: string, persistent: boolean): number {
	const { exports, memory } = connection.runtime.instance;
	const text = memory.allocCString(sql);
	try {
		const first = compile(connection, text.pointer, text.length, persistent ? 1 : 0, sql);
		if (first.pointer === 0) throw new RangeError("sqlite-wasm: the SQL contains no statement");
		const rest = text.length - first.used;
		let second = 0;
		try {
			if (rest > 0) second = compile(connection, text.pointer + first.used, rest, 0, sql).pointer;
		} catch (thrown) {
			exports.sqlite3_finalize(first.pointer);
			throw thrown;
		}
		if (second !== 0) {
			exports.sqlite3_finalize(second);
			exports.sqlite3_finalize(first.pointer);
			throw new RangeError("sqlite-wasm: the SQL contains more than one statement; use db.execute() for scripts");
		}
		return first.pointer;
	} finally {
		memory.free(text.pointer);
	}
}

/** Binds `parameters` to `stmt`, throwing the SQLite error if a bind fails. */
export function bind(connection: Connection, stmt: number, parameters: readonly unknown[], sql: string): void {
	const rc = bindAll(connection.runtime.instance, stmt, parameters);
	if (rc !== SQLITE_OK) throw failure(connection, rc, sql);
}

/** Column names of `stmt`. */
export function columnNames(connection: Connection, stmt: number): string[] {
	const { exports, memory } = connection.runtime.instance;
	const names: string[] = [];
	for (let i = 0; i < exports.sqlite3_column_count(stmt); i++)
		names.push(memory.readCString(exports.sqlite3_column_name(stmt, i)) as string);
	return names;
}

/** Runs one internal statement and returns its rows as objects. */
export function query(connection: Connection, sql: string, parameters: readonly unknown[] = []): Record<string, value>[] {
	const { exports } = connection.runtime.instance;
	const stmt = prepareOne(connection, sql, false);
	try {
		bind(connection, stmt, parameters, sql);
		const names = columnNames(connection, stmt);
		const rows: Record<string, value>[] = [];
		while (step(connection, stmt, sql)) {
			const row: Record<string, value> = {};
			names.forEach((name, i) => (row[name] = columnValue(connection.runtime.instance, stmt, i, connection.bigint)));
			rows.push(row);
		}
		return rows;
	} finally {
		exports.sqlite3_finalize(stmt);
	}
}

/** Whether the connection is inside a transaction. */
export function inTransaction(connection: Connection): boolean {
	return connection.db !== 0 && connection.runtime.instance.exports.sqlite3_get_autocommit(connection.db) === 0;
}
