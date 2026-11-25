/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/client.mts
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
import { error, type endpoint, type settings, type value } from "./protocol.mts";
import { type watcher } from "./share.mts";
/** Options for `connect()`: the worker's open settings, and `share` to use one database from several tabs. */
export type options = settings & {
    /** Share the database with the origin's other tabs that connect with `share: true` (needs the worker's URL). */
    share?: boolean;
};
/** What `connect()` talks to: a worker script's URL (a module worker is started), or a Worker / MessagePort already running the host. */
export type target = string | URL | endpoint;
/** A row as an object keyed by column name. */
export type row = Record<string, unknown>;
/** What `run()` resolves to. */
export interface result {
    changes: number;
    rowid: number | bigint;
}
/** Row readers that return positional arrays, the first column, or objects grouped by table. */
export interface reader<item> {
    get(...params: unknown[]): Promise<item | undefined>;
    all(...params: unknown[]): Promise<item[]>;
}
/** A statement on the client. Nothing is compiled until the first call; the worker caches the compiled statement. */
export interface statement {
    run(...params: unknown[]): Promise<result>;
    get(...params: unknown[]): Promise<row | undefined>;
    all(...params: unknown[]): Promise<row[]>;
    iterate(...params: unknown[]): AsyncGenerator<row>;
    iter(...params: unknown[]): AsyncGenerator<row>;
    raw: reader<unknown[]> & {
        iterate(...params: unknown[]): AsyncGenerator<unknown[]>;
        iter(...params: unknown[]): AsyncGenerator<unknown[]>;
    };
    pluck: reader<unknown>;
    expand: reader<Record<string, row>>;
    bind(...params: unknown[]): statement;
    columns(): Promise<unknown[]>;
    cols(): Promise<unknown[]>;
    close(): void;
    info: {
        readonly sql: string;
    };
}
/** The PRAGMA helpers. */
export interface pragma {
    get(name: string): Promise<unknown>;
    set(name: string, value: value): Promise<void>;
    all(name: string, argument?: value): Promise<row[]>;
}
/** What a transaction callback receives. */
export interface transaction {
    prepare(sql: string): statement;
    prep(sql: string): statement;
    execute(sql: string): Promise<void>;
    exec(sql: string): Promise<void>;
    pragma: pragma;
}
/** Runs `callback` as one transaction: committed when it resolves, rolled back when it throws. */
export interface runner {
    <value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
    deferred<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
    immediate<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
    exclusive<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
}
/** The drizzle `sqlite-proxy` callback. */
export type proxy = (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => Promise<{
    rows: unknown;
}>;
/** `db.fn` on the client: every method throws, since functions have to be registered in the worker. */
export interface fn {
    scalar(...ignored: unknown[]): never;
    aggregate(...ignored: unknown[]): never;
    agg(...ignored: unknown[]): never;
    collation(...ignored: unknown[]): never;
}
/** A connection to a database in a worker. */
export interface database extends transaction {
    transaction: runner;
    tx: runner;
    fn: fn;
    attach(path: string, schema: string): Promise<void>;
    detach(schema: string): Promise<void>;
    /** Copies the database (or the attached `options.schema`) into `target` in the worker's storage. */
    backup(target: string, options?: {
        schema?: string;
    }): Promise<void>;
    /** The database (or attached `schema`) as the bytes of an SQLite file; the buffer is transferred from the worker. */
    serialize(schema?: string): Promise<Uint8Array>;
    checkpoint(mode?: "passive" | "full" | "restart" | "truncate"): Promise<row | undefined>;
    ckpt(mode?: "passive" | "full" | "restart" | "truncate"): Promise<row | undefined>;
    close(): Promise<void>;
    proxy: proxy;
    info: {
        readonly path: string;
        readonly storage: string;
        readonly lock: string;
        readonly open: boolean;
        readonly transaction: boolean;
    };
}
/** A connection made with `share: true`: `info` also says whether this tab leads, and reports changes. */
export interface shared extends database {
    info: database["info"] & {
        /** Whether this tab's worker holds the database (the leader) or this tab goes through another tab (a follower). */
        readonly leader: boolean;
        /** Calls `listener` with the new value whenever `leader` changes; returns the function that stops it. */
        watch(listener: watcher): () => void;
    };
}
/**
 * Opens `path` in a worker running the host (`host.listen()`).
 * @param target   the worker script's URL (started as a module worker, and terminated on close), or a Worker /
 *                 MessagePort already connected to a host
 * @param path     the database path in OPFS (or a name, with `storage: "memory"`)
 * @param options  storage, journal mode, readonly, create, and `share` to share the database between tabs
 */
export declare function connect(target: target, path: string, options: options & {
    share: true;
}): Promise<shared>;
export declare function connect(target: target, path: string, options?: options): Promise<database>;
/** The client as a namespace: `client.connect(...)`; `client.error` (alias `err`) is the class calls reject with. */
declare const client: {
    connect: typeof connect;
    error: typeof error;
    err: typeof error;
};
export default client;
export { error, error as err };
