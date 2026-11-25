/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/fs.mts
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
/** Options for `create()`. */
export interface options {
    /** How long opening a database waits for another process's owner lock before SQLITE_BUSY, in ms. Default 5000. */
    timeout?: number;
}
/** Options for `prepare()`; `sqlite.open()` passes its own (path, readonly and create are not used here). */
export interface preparation {
    /** How long to wait for another process's lock, in ms; the driver's own timeout when omitted. */
    timeout?: number;
    /** "beside" (default), "temp", "db" or a folder path. */
    lock?: string;
}
/**
 * The root folder of "temp" locks. On POSIX it is per user and must be private: created with mode 0700, and refused
 * when it is a symlink or not a directory, belongs to another user, or is group- or world-writable (another user could
 * otherwise pre-create it, or plant a link, and see or steal every lock in it).
 */
export declare function temporaryLocks(): string;
/** The resolved real path of a database file, or of its folder plus its name when the file doesn't exist yet. */
export declare function real(path: string): string;
/** The lock folder for `path` under `parent`: named by the SHA-256 of the file's real path. */
export declare function hashed(parent: string, path: string): string;
/** Driver for real files on disk. */
export declare class driver implements VfsDriver {
    #private;
    constructor(timeout: number);
    /**
     * Takes the owner lock of the kind `settings.lock` asks for and returns the name SQLite opens (the resolved path).
     * Waits for another process up to `settings.timeout`, then fails with SQLITE_BUSY.
     */
    prepare(path: string, settings?: preparation): Promise<string>;
    /** Drops what `prepare()` took for `name`. */
    release(name: string): void;
    /** The lock kind in effect for a prepared `name` ("beside" for a file opened without `prepare()`). */
    held(name: string): string;
    open(name: string | null, fileId: number, flags: number): number;
    delete(name: string): number;
    access(name: string, flags: number): boolean;
    fullPathname(name: string): string;
    read(fileId: number, target: Uint8Array, offset: number): number;
    write(fileId: number, data: Uint8Array, offset: number): number;
    truncate(fileId: number, size: number): number;
    sync(fileId: number, flags: number): number;
    size(fileId: number): number;
    lock(fileId: number, level: number): number;
    unlock(fileId: number, level: number): number;
    checkReserved(fileId: number): boolean;
    close(fileId: number): number;
    sectorSize(): number;
    deviceCharacteristics(): number;
}
/**
 * Creates a driver for real files. One driver can serve any number of connections; locks are tracked per process.
 * @param settings  `timeout`: how long an open waits for another process's owner lock (ms, default 5000)
 */
export declare function create(settings?: options): driver;
