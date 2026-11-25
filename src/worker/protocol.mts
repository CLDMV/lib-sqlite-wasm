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
 * Values are sent with the structured clone algorithm, which keeps bigint, Uint8Array and null as they are. A
 * serialized database's buffer is transferred rather than copied.
 *
 * Nested transactions travel as `savepoint` / `release` / `revert` (ROLLBACK TO and RELEASE) calls inside the
 * outer transaction's requests; a failing call inside a savepoint undoes only that savepoint.
 */
import { error } from "../api/error.mts";
import { codeName } from "../core/codes.mts";

/** A bound parameter value. */
export type value = null | number | bigint | string | Uint8Array | boolean;
/** Positional parameters, or one object of named parameters. */
export type parameters = value[] | Record<string, value>;
/** How a statement's rows come back: objects, positional arrays, the first column, or grouped by table. */
export type shape = "run" | "object" | "raw" | "pluck" | "expand";
/** Journal modes `open` accepts. */
export type journal = "wal" | "truncate" | "delete";

/**
 * Options for opening a database in the worker: `sqlite.open()`'s options, except that storage is "opfs" (the
 * default) or "memory", and there is no `lock` (the browser always uses Web Locks).
 */
export interface settings {
	/** "opfs" (the default) or "memory". */
	storage?: "opfs" | "memory";
	journal?: journal;
	sync?: "off" | "normal" | "full" | "extra";
	foreign?: boolean;
	readonly?: boolean;
	create?: boolean;
	timeout?: number;
	bigint?: boolean;
}

/** One operation the host performs. */
export type call =
	| { op: "open"; path: string; options: settings }
	| { op: "execute"; sql: string }
	| { op: "statement"; sql: string; params: parameters; shape: shape; first: boolean }
	| { op: "columns"; sql: string }
	| { op: "attach"; path: string; schema: string }
	| { op: "detach"; schema: string }
	| { op: "backup"; target: string; schema?: string }
	| { op: "serialize"; schema?: string }
	| { op: "begin"; mode: string }
	| { op: "commit" }
	| { op: "rollback" }
	| { op: "savepoint"; name: string }
	| { op: "release"; name: string }
	| { op: "revert"; name: string }
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
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	start?(): void;
}

/**
 * The error a call rejects with on the client: `sqlite.error`, the same class the worker throws. An Error loses its
 * class and extra fields in postMessage (structured clone keeps only name and message), so the host sends the fields
 * and the client rebuilds the error from them. Each published entry bundles its own copy of the class, so an error
 * from `@cldmv/sqlite-wasm/worker` is an instance of that entry's `client.error`, not of the `sqlite.error` the main
 * entry exports; `code` and `number` are the same either way.
 */
export { error };

/**
 * Prepares an error for postMessage. Anything with a numeric `number` is an SQLite error; its own `sql` wins over the
 * statement the call ran (they differ only for errors that don't come from a statement).
 */
export function serialize(thrown: unknown, sql?: string): failure {
	if (!(thrown instanceof Error)) return { name: "Error", message: String(thrown) };
	const fields = thrown as Error & { number?: unknown; sql?: unknown };
	if (typeof fields.number !== "number") return { name: thrown.name, message: thrown.message };
	const statement = typeof fields.sql === "string" ? fields.sql : sql;
	const wire: failure = { name: "sqlite.error", message: thrown.message, code: codeName(fields.number), number: fields.number };
	if (statement !== undefined) wire.sql = statement;
	return wire;
}

/** Turns a received failure back into an Error: `sqlite.error` for SQLite errors, a plain Error (with its name) otherwise. */
export function revive(data: failure): Error {
	if (data.number !== undefined) return new error(data.message, data.number, data.sql);
	const plain = new Error(data.message);
	plain.name = data.name;
	return plain;
}
