/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/opfs.mts
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
import type { VfsDriver } from "../core/vfs-imports.mts";
/** The subset of `FileSystemSyncAccessHandle` the driver uses. */
export interface handle {
    read(buffer: Uint8Array, options: {
        at: number;
    }): number;
    write(buffer: Uint8Array, options: {
        at: number;
    }): number;
    truncate(size: number): void;
    getSize(): number;
    flush(): void;
    close(): void;
}
/** The subset of `FileSystemFileHandle` the driver uses. */
export interface file {
    createSyncAccessHandle(): Promise<handle>;
}
/** The subset of `FileSystemDirectoryHandle` the driver uses. */
export interface directory {
    getDirectoryHandle(name: string, options?: {
        create?: boolean;
    }): Promise<directory>;
    getFileHandle(name: string, options?: {
        create?: boolean;
    }): Promise<file>;
    removeEntry(name: string): Promise<void>;
}
/** The subset of the Web Locks `LockManager` the driver uses. */
export interface locks {
    request(name: string, options: {
        ifAvailable?: boolean;
        signal?: AbortSignal;
    }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}
/** Options for `create()`. */
export interface options {
    /** The directory databases live in; `navigator.storage.getDirectory()` when omitted. */
    root?: directory | Promise<directory>;
    /** The Web Locks manager; `navigator.locks` when omitted. Pass `null` to rely on the exclusive sync handles alone. */
    locks?: locks | null;
    /**
     * How long `prepare()` waits, in milliseconds, for another tab to close the database. `0` fails at once,
     * `Infinity` waits for as long as it takes. Defaults to `timeout`, else 0.
     */
    wait?: number;
    /** The open's busy timeout; `sqlite.open()` passes it, and it is the default for `wait`. */
    timeout?: number;
}
/** Options for `prepare()`. */
export interface preparation {
    /** Create the database file when it doesn't exist (default true). */
    create?: boolean;
}
/** The OPFS driver: a VFS driver plus the asynchronous steps around opening and closing a database. */
export interface driver extends VfsDriver {
    /**
     * Takes the database's lock and opens its files. Await it before `sqlite3_open_v2`, and pass the returned name to
     * it: SQLite derives the journal and WAL names from that exact string.
     */
    prepare(path: string, options?: preparation): Promise<string>;
    /** Closes what `prepare()` opened and drops the lock. Call it after the connection is closed. */
    release(path: string): Promise<void>;
    /** The lock that keeps other tabs out: "web" with Web Locks, "none" when they are switched off (`locks: null`). */
    held(): string;
}
/**
 * Turns a path into the canonical name SQLite uses for it: `/`-separated, with a leading `/`, no empty or `.`
 * segments. `..` is refused since OPFS has no parent of the root.
 */
export declare function normalize(path: string): string;
/**
 * Creates an OPFS driver. One driver can serve any number of databases; each database is opened by one connection.
 * `sqlite.open()` calls it with its own options ({ path, readonly, create, timeout, lock }); everything this driver
 * doesn't know is ignored, and `root` / `locks` fall back to the browser's own.
 */
export declare function create(options?: options): driver;
/** The driver factory, as a namespace: `opfs.create(options)`. */
declare const opfs: {
    create: typeof create;
    normalize: typeof normalize;
};
export default opfs;
