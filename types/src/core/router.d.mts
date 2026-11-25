/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/router.mts
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
import type { VfsDriver } from "./vfs-imports.mts";
/** Thrown by `register()` when a name is already registered with a different driver. */
export declare class RouteConflict extends Error {
}
/** Routes VFS calls by file name (on open) and by file id (afterwards). */
export declare class VfsRouter implements VfsDriver {
    #private;
    constructor(fallback: VfsDriver);
    /**
     * Sends `name` (and the driver's full pathname for it) to `driver` until the returned function is called. Names are
     * reference counted, so two connections to the same database can each register and release it.
     *
     * `key` says which drivers are interchangeable for one name; it defaults to the driver itself. Drivers of one
     * storage kind that keep their per-file state process-wide (the node-fs driver) pass the kind, so two connections
     * to one file can each bring their own driver object; the name stays routed to the first one.
     */
    register(name: string, driver: VfsDriver, key?: unknown): () => void;
    /** The driver for a file name: an exact match, else the longest registered name followed by "-", else the fallback. */
    route(name: string): VfsDriver;
    open(name: string | null, fileId: number, flags: number): number;
    delete(name: string, syncDir: boolean): number;
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
    sectorSize(fileId: number): number;
    deviceCharacteristics(fileId: number): number;
}
