/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/vfs-imports.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:15-08:00 (1795598295)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import type { WasmMemory } from "./memory.mts";
/**
 * A storage driver. Every method is synchronous and returns an SQLite result code unless noted. File ids are unique
 * across every module instance in the process, so one driver object can serve several connections.
 */
export interface VfsDriver {
    /** Opens or creates `name` (null: a temporary file the driver names itself) as `fileId`. */
    open(name: string | null, fileId: number, flags: number): number;
    /** Deletes `name`; `SQLITE_IOERR_DELETE_NOENT` when it doesn't exist. */
    delete(name: string, syncDir: boolean): number;
    /** Whether `name` exists / is readable / writable (`flags` is a SQLITE_ACCESS_* value). */
    access(name: string, flags: number): boolean;
    /** The canonical name for `name`; journal and WAL names are derived from it. */
    fullPathname(name: string): string;
    /** Fills `target` from `offset`. A short read zero-fills the rest and returns `SQLITE_IOERR_SHORT_READ`. `target` is a view into wasm memory: copy out of it, never keep it. */
    read(fileId: number, target: Uint8Array, offset: number): number;
    /** Writes `data` at `offset`, growing the file as needed. `data` is a view into wasm memory: copy it, never keep it. */
    write(fileId: number, data: Uint8Array, offset: number): number;
    truncate(fileId: number, size: number): number;
    sync(fileId: number, flags: number): number;
    /** The file's size in bytes (not a result code). */
    size(fileId: number): number;
    lock(fileId: number, level: number): number;
    unlock(fileId: number, level: number): number;
    /** Whether any connection holds a RESERVED or higher lock on the file (not a result code). */
    checkReserved(fileId: number): boolean;
    close(fileId: number): number;
    /** Sector size in bytes (not a result code). */
    sectorSize(fileId: number): number;
    /** SQLITE_IOCAP_* bits (not a result code). */
    deviceCharacteristics(fileId: number): number;
}
/** Combines the two 32-bit halves glue.c passes for a 64-bit offset. */
export declare function joinOffset(lo: number, hi: number): number;
/** Called with whatever a driver threw before its import returned an error code. */
export type VfsErrorHandler = (error: unknown) => void;
/**
 * Builds the `env.vfs_*` import functions for one module instance.
 * @param driver   where the calls go
 * @param memory   the instance's memory; read lazily, since the imports object is built before instantiation
 * @param onError  receives exceptions thrown by the driver
 */
export declare function createVfsImports(driver: VfsDriver, memory: () => WasmMemory, onError: VfsErrorHandler): Record<string, (...args: number[]) => number>;
