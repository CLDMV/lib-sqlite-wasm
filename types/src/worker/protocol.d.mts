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
 *
 * `hold` asks the worker to take a Web Lock and keep it for the rest of its life. A shared connection's leader waits on
 * that lock to learn when its worker has ended.
 */
import { error } from "../api/error.mts";
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
export type call = {
    op: "open";
    path: string;
    options: settings;
} | {
    op: "execute";
    sql: string;
} | {
    op: "statement";
    sql: string;
    params: parameters;
    shape: shape;
    first: boolean;
} | {
    op: "columns";
    sql: string;
} | {
    op: "attach";
    path: string;
    schema: string;
} | {
    op: "detach";
    schema: string;
} | {
    op: "backup";
    target: string;
    schema?: string;
} | {
    op: "serialize";
    schema?: string;
} | {
    op: "begin";
    mode: string;
} | {
    op: "commit";
} | {
    op: "rollback";
} | {
    op: "savepoint";
    name: string;
} | {
    op: "release";
    name: string;
} | {
    op: "revert";
    name: string;
} | {
    op: "close";
} | {
    op: "hold";
    name: string;
};
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
export type outcome = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: failure;
};
/** Host -> client. */
export interface response {
    id: number;
    outcomes: outcome[];
}
/** The minimal message endpoint both sides use: a Worker, a worker's global scope, or a MessagePort. */
export interface endpoint {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    start?(): void;
}
/**
 * The error a call rejects with on the client: `sqlite.error`, the same class the worker throws. An Error loses its
 * class and extra fields in postMessage (structured clone keeps only name and message), so the host sends the fields
 * and the client rebuilds the error from them. The published entries share one copy of the class (dist/ is built with
 * code splitting), so `client.error` is `sqlite.error` and an error from `@cldmv/sqlite-wasm/worker` is an instance of
 * the class the main entry exports.
 */
export { error };
/**
 * Prepares an error for postMessage. Anything with a numeric `number` is an SQLite error; its own `sql` wins over the
 * statement the call ran (they differ only for errors that don't come from a statement).
 */
export declare function serialize(thrown: unknown, sql?: string): failure;
/** Turns a received failure back into an Error: `sqlite.error` for SQLite errors, a plain Error (with its name) otherwise. */
export declare function revive(data: failure): Error;
/** What opening a database reports back: the resolved path, the storage and the lock in effect. */
export interface opened {
    path: string;
    storage: string;
    lock: string;
}
/**
 * Messages between tabs that share one database (`connect(..., { share: true })`), sent over a BroadcastChannel named
 * `sqlite:<path>`. Every tab sees every message, so each one names the tab it is for or from.
 *
 * - `hello`: a tab joined and wants to know the leader.
 * - `leader`: the leader's announcement, sent when it has opened the database and in answer to `hello`.
 * - `request`: a follower's request for the leader named in `to`; a leader ignores requests addressed to another tab.
 * - `started`: the leader is about to run a follower's write, so a retry after a handover could run it twice.
 * - `response`: the leader's answer to a follower's request.
 */
export type notice = {
    type: "hello";
    tab: string;
} | {
    type: "leader";
    tab: string;
    info: opened;
} | {
    type: "request";
    to: string;
    tab: string;
    write: boolean;
    request: request;
} | {
    type: "started";
    leader: string;
    tab: string;
    id: number;
} | {
    type: "response";
    tab: string;
    response: response;
};
