/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/registry.mts
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
import type { VfsDriver } from "../core/vfs-imports.mts";
import { MemoryDriver } from "./memory.mts";
/** A concrete storage kind ("auto" resolves to one of these). */
export type StorageKind = "memory" | "fs" | "opfs";
/** What a driver factory is told about the file it is opened for. */
export interface DriverOptions {
    /** The database path as the caller passed it. */
    path: string;
    /** Opened read-only. */
    readonly: boolean;
    /** The file may be created. */
    create: boolean;
    /** Busy timeout in milliseconds; also how long opening waits for another process or tab to let go. */
    timeout: number;
    /** The cross-process lock: "beside", "temp", "db" or a folder path (node-fs only; other drivers ignore it). */
    lock: string;
}
/**
 * A driver as a module's `create()` returns it. Drivers whose files must be made ready asynchronously before SQLite
 * touches them (OPFS: a Web Lock plus sync access handles for the database, -journal and -wal; node-fs: the owner
 * lock) add hooks:
 *   - `prepare(path, options)` runs before sqlite3_open_v2 / ATTACH and resolves to the name SQLite opens;
 *   - `release(name)` runs after sqlite3_close_v2 / DETACH (and when an open or attach fails after `prepare`). Close
 *     is synchronous, so a promise it returns is not awaited and its rejection is ignored;
 *   - `held(name)` reports the lock kind in effect for a prepared name (`db.info.lock`).
 */
export interface StorageDriver extends VfsDriver {
    prepare?(path: string, options: DriverOptions): Promise<string>;
    release?(name: string): unknown;
    held?(name: string): string;
}
/** The shape of a driver module (src/vfs/<kind>.mts). */
export interface DriverModule {
    create(options: DriverOptions): StorageDriver | Promise<StorageDriver>;
}
/** The process-wide memory driver; also the router's fallback for temporary files. */
export declare function sharedMemory(): MemoryDriver;
/**
 * Replaces the loader for `kind` and returns the previous one. Internal: tests use it to stand in drivers, and a phase
 * that adds a driver module can try it before the static import above is switched over.
 */
export declare function install(kind: StorageKind, loader: () => Promise<DriverModule>): () => Promise<DriverModule>;
/** The globals `detect()` looks at. */
export interface Environment {
    process?: {
        versions?: {
            node?: string;
        };
    };
    FileSystemSyncAccessHandle?: unknown;
}
/**
 * The storage "auto" means here: files in Node, OPFS in a dedicated browser worker. Anywhere else (a browser main
 * thread, a shared or service worker) there is no persistent synchronous storage, and "auto" refuses with an error
 * that says what to do instead; `storage: "memory"` still works there.
 */
export declare function detect(scope?: Environment): StorageKind;
/** Whether `value` names a storage kind or "auto". */
export declare function isStorage(value: unknown): value is StorageKind | "auto";
/** Loads the driver module for `kind` and creates a driver for one database file. */
export declare function load(kind: StorageKind, options: DriverOptions): Promise<StorageDriver>;
