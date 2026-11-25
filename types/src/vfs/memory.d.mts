/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/memory.mts
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
import type { VfsDriver } from "../core/vfs-imports.mts";
/** Storage driver that keeps every file in memory. */
export declare class MemoryDriver implements VfsDriver {
    #private;
    /** Names of the files that currently exist. */
    files(): string[];
    /** A copy of a file's contents, or undefined when it doesn't exist. */
    contents(name: string): Uint8Array | undefined;
    open(name: string | null, fileId: number, flags: number): number;
    delete(name: string): number;
    access(name: string): boolean;
    fullPathname(name: string): string;
    read(fileId: number, target: Uint8Array, offset: number): number;
    write(fileId: number, data: Uint8Array, offset: number): number;
    truncate(fileId: number, size: number): number;
    sync(): number;
    size(fileId: number): number;
    lock(fileId: number, level: number): number;
    unlock(fileId: number, level: number): number;
    checkReserved(fileId: number): boolean;
    close(fileId: number): number;
    sectorSize(): number;
    deviceCharacteristics(): number;
}
