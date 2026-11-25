/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/open.mts
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
import { type DriverOptions, type StorageKind } from "../vfs/registry.mts";
import { type Connection } from "./connection.mts";
import { database } from "./database.mts";
import { type Runtime } from "./runtime.mts";
/** Where the database lives: "auto" picks files in Node, OPFS in a browser worker, memory elsewhere. */
export type storage = "auto" | "memory" | "fs" | "opfs";
/** Rollback journal or write-ahead log. */
export type journal = "wal" | "truncate" | "delete";
/** `PRAGMA synchronous` level. */
export type sync = "off" | "normal" | "full" | "extra";
/** Options for `sqlite.open()`. */
export interface options {
    /** Storage driver; default "auto". `:memory:` and "" always use memory. */
    storage?: storage;
    /** Open read-only; default false. */
    readonly?: boolean;
    /** Create the file if it doesn't exist; default true (ignored when read-only). */
    create?: boolean;
    /** Journal mode; default "wal". */
    journal?: journal;
    /** `PRAGMA synchronous`; default "normal". */
    sync?: sync;
    /** Enforce foreign keys; default true. */
    foreign?: boolean;
    /** How long to wait for a lock, in milliseconds; default 5000. */
    timeout?: number;
    /** Return every INTEGER as a bigint; default false (only integers outside ±2^53 are bigints). */
    bigint?: boolean;
    /**
     * How other processes are kept out (Node only; browsers always use Web Locks and ignore it): "beside" (default) a
     * `<db>.lock/` folder, falling back to "temp" where that can't be created; "temp" a folder under the OS temp
     * folder; a folder path of your own; or "db", a row in a `_cldmv_lock` table that detects a second process but
     * can't prevent two opening at the same instant.
     */
    lock?: lock;
}
/** The `lock` option: "beside", "temp", "db", or a folder path. */
export type lock = string;
/** Fully resolved options. */
export interface Settings {
    storage: StorageKind;
    readonly: boolean;
    create: boolean;
    journal: journal;
    sync: sync;
    foreign: boolean;
    timeout: number;
    bigint: boolean;
    lock: string;
}
/** The storage kind for `path`: memory for SQLite's in-memory and temporary names, else `storage` resolved. */
export declare function resolveStorage(path: string, storage: storage): StorageKind;
/** Validates `options` and fills in the defaults. */
export declare function settings(path: unknown, options: unknown): Settings;
/** A database file claimed for one connection or attachment: the name SQLite opens, the lock in effect, and how to give it back. */
export interface Claim {
    name: string;
    lock: string;
    /** Undoes the claim at once; the promise settles when the driver's own release has finished (never rejects). */
    release: () => Promise<void>;
}
/**
 * Loads the driver for one database file, lets it prepare the file (when it has a `prepare` hook) and routes the
 * resulting name to it. `release()` undoes both: the route, then the driver's `release` hook.
 */
export declare function claim(shared: Runtime, storage: StorageKind, options: DriverOptions): Promise<Claim>;
/**
 * Opens `path` with resolved settings and returns its connection state. `extra` goes to the driver factory along with
 * the public options (the worker host passes its OPFS `root`, `locks` and `wait` this way).
 */
export declare function connect(path: string, resolved: Settings, extra?: Record<string, unknown>): Promise<Connection>;
/** The table the "db" lock keeps its rows in. */
export declare const LOCK_TABLE = "_cldmv_lock";
/** Opens a database. */
export declare function open(path: string, options?: options): Promise<database>;
