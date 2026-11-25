/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/protocol.mts
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The messages between the main-thread client and the worker host, and how errors cross between them.
 *
 * The client sends a request: an id and a list of calls. The host answers once per request with one outcome per
 * call, in order. Calls the client makes in the same tick travel in one request. A request marked `tx` belongs to a
 * transaction the client is running: after a failing call the host skips the rest and rolls back. Calls in an
 * ordinary request are independent; the host may still run neighbouring statements inside one transaction so they
 * share a single commit.
 *
 * Values are sent with the structured clone algorithm, which keeps bigint, Uint8Array and null as they are.
 */

/** A bound parameter value. */
export type value = null | number | bigint | string | Uint8Array | boolean;
/** Positional parameters, or one object of named parameters. */
export type parameters = value[] | Record<string, value>;
/** How a statement's rows come back: objects, positional arrays, the first column, or grouped by table. */
export type shape = "run" | "object" | "raw" | "pluck" | "expand";
/** Journal modes `open` accepts. */
export type journal = "wal" | "truncate" | "delete";

/** Options for opening a database in the worker. */
export interface settings {
	/** "opfs" (the default) or "memory". */
	storage?: "opfs" | "memory";
	journal?: journal;
	readonly?: boolean;
	create?: boolean;
}

/** One operation the host performs. */
export type call =
	| { op: "open"; path: string; options: settings }
	| { op: "execute"; sql: string }
	| { op: "statement"; sql: string; params: parameters; shape: shape; first: boolean }
	| { op: "columns"; sql: string }
	| { op: "attach"; path: string; schema: string }
	| { op: "detach"; schema: string }
	| { op: "begin"; mode: string }
	| { op: "commit" }
	| { op: "rollback" }
	| { op: "close" };

/** Client -> host. */
export interface request {
	id: number;
	tx: boolean;
	calls: call[];
}

/** An error in transit. `number` is set for SQLite errors. */
export interface failure {
	name: string;
	message: string;
	code?: string;
	number?: number;
	sql?: string;
}

/** The result of one call. */
export type outcome = { ok: true; value: unknown } | { ok: false; error: failure };

/** Host -> client. */
export interface response {
	id: number;
	outcomes: outcome[];
}

/** The minimal message endpoint both sides use: a Worker, a worker's global scope, or a MessagePort. */
export interface endpoint {
	postMessage(message: unknown): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	start?(): void;
}

/** Primary result code names, by number. */
const PRIMARY: Record<number, string> = {
	0: "OK",
	1: "ERROR",
	2: "INTERNAL",
	3: "PERM",
	4: "ABORT",
	5: "BUSY",
	6: "LOCKED",
	7: "NOMEM",
	8: "READONLY",
	9: "INTERRUPT",
	10: "IOERR",
	11: "CORRUPT",
	12: "NOTFOUND",
	13: "FULL",
	14: "CANTOPEN",
	15: "PROTOCOL",
	16: "EMPTY",
	17: "SCHEMA",
	18: "TOOBIG",
	19: "CONSTRAINT",
	20: "MISMATCH",
	21: "MISUSE",
	22: "NOLFS",
	23: "AUTH",
	24: "FORMAT",
	25: "RANGE",
	26: "NOTADB",
	27: "NOTICE",
	28: "WARNING",
	100: "ROW",
	101: "DONE"
};

/** Extended result code names, by number (sqlite3.h). */
const EXTENDED: Record<number, string> = {
	[19 | (1 << 8)]: "CONSTRAINT_CHECK",
	[19 | (2 << 8)]: "CONSTRAINT_COMMITHOOK",
	[19 | (3 << 8)]: "CONSTRAINT_FOREIGNKEY",
	[19 | (4 << 8)]: "CONSTRAINT_FUNCTION",
	[19 | (5 << 8)]: "CONSTRAINT_NOTNULL",
	[19 | (6 << 8)]: "CONSTRAINT_PRIMARYKEY",
	[19 | (7 << 8)]: "CONSTRAINT_TRIGGER",
	[19 | (8 << 8)]: "CONSTRAINT_UNIQUE",
	[19 | (9 << 8)]: "CONSTRAINT_VTAB",
	[19 | (10 << 8)]: "CONSTRAINT_ROWID",
	[19 | (11 << 8)]: "CONSTRAINT_PINNED",
	[19 | (12 << 8)]: "CONSTRAINT_DATATYPE",
	[5 | (1 << 8)]: "BUSY_RECOVERY",
	[5 | (2 << 8)]: "BUSY_SNAPSHOT",
	[5 | (3 << 8)]: "BUSY_TIMEOUT",
	[6 | (1 << 8)]: "LOCKED_SHAREDCACHE",
	[6 | (2 << 8)]: "LOCKED_VTAB",
	[8 | (1 << 8)]: "READONLY_RECOVERY",
	[8 | (2 << 8)]: "READONLY_CANTLOCK",
	[8 | (3 << 8)]: "READONLY_ROLLBACK",
	[8 | (4 << 8)]: "READONLY_DBMOVED",
	[8 | (5 << 8)]: "READONLY_CANTINIT",
	[8 | (6 << 8)]: "READONLY_DIRECTORY",
	[4 | (2 << 8)]: "ABORT_ROLLBACK",
	[11 | (1 << 8)]: "CORRUPT_VTAB",
	[11 | (2 << 8)]: "CORRUPT_SEQUENCE",
	[11 | (3 << 8)]: "CORRUPT_INDEX",
	[14 | (1 << 8)]: "CANTOPEN_NOTEMPDIR",
	[14 | (2 << 8)]: "CANTOPEN_ISDIR",
	[14 | (3 << 8)]: "CANTOPEN_FULLPATH",
	[14 | (4 << 8)]: "CANTOPEN_CONVPATH",
	[14 | (6 << 8)]: "CANTOPEN_SYMLINK",
	[1 | (1 << 8)]: "ERROR_MISSING_COLLSEQ",
	[1 | (2 << 8)]: "ERROR_RETRY",
	[1 | (3 << 8)]: "ERROR_SNAPSHOT",
	[10 | (1 << 8)]: "IOERR_READ",
	[10 | (2 << 8)]: "IOERR_SHORT_READ",
	[10 | (3 << 8)]: "IOERR_WRITE",
	[10 | (4 << 8)]: "IOERR_FSYNC",
	[10 | (5 << 8)]: "IOERR_DIR_FSYNC",
	[10 | (6 << 8)]: "IOERR_TRUNCATE",
	[10 | (7 << 8)]: "IOERR_FSTAT",
	[10 | (8 << 8)]: "IOERR_UNLOCK",
	[10 | (9 << 8)]: "IOERR_RDLOCK",
	[10 | (10 << 8)]: "IOERR_DELETE",
	[10 | (12 << 8)]: "IOERR_NOMEM",
	[10 | (13 << 8)]: "IOERR_ACCESS",
	[10 | (14 << 8)]: "IOERR_CHECKRESERVEDLOCK",
	[10 | (15 << 8)]: "IOERR_LOCK",
	[10 | (16 << 8)]: "IOERR_CLOSE",
	[10 | (23 << 8)]: "IOERR_DELETE_NOENT",
	[10 | (26 << 8)]: "IOERR_CORRUPTFS"
};

/** `SQLITE_<NAME>` for an (extended) result code; the primary name when the extended one isn't known. */
export function label(number: number): string {
	return `SQLITE_${EXTENDED[number] ?? PRIMARY[number & 0xff] ?? "UNKNOWN"}`;
}

/** The error a call rejects with on the client: same `code`, `number` and `sql` as the worker-side error. */
export class error extends Error {
	readonly code: string;
	readonly number: number;
	readonly sql: string | undefined;

	constructor(message: string, number: number, code: string = label(number), sql?: string) {
		super(message);
		this.name = "SqliteError";
		this.code = code;
		this.number = number;
		this.sql = sql;
	}
}

/** Prepares an error for postMessage. Anything with a numeric `number` or `errcode` is an SQLite error. */
export function serialize(thrown: unknown, sql?: string): failure {
	if (!(thrown instanceof Error)) return { name: "Error", message: String(thrown) };
	const fields = thrown as Error & { number?: unknown; errcode?: unknown; code?: unknown };
	const number = typeof fields.number === "number" ? fields.number : typeof fields.errcode === "number" ? fields.errcode : undefined;
	if (number === undefined) return { name: thrown.name, message: thrown.message };
	const code = typeof fields.code === "string" ? fields.code : label(number);
	return sql === undefined
		? { name: "SqliteError", message: thrown.message, code, number }
		: { name: "SqliteError", message: thrown.message, code, number, sql };
}

/** Turns a received failure back into an Error: `error` for SQLite errors, a plain Error (with its name) otherwise. */
export function revive(data: failure): Error {
	if (data.number !== undefined) return new error(data.message, data.number, data.code, data.sql);
	const plain = new Error(data.message);
	plain.name = data.name;
	return plain;
}
