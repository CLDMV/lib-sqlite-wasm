/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/memory.mts
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
/** The allocator exports every module provides. */
export interface Allocator {
    malloc(size: number): number;
    free(pointer: number): void;
}
/** A zero-terminated UTF-8 string copied into wasm memory. */
export interface CString {
    /** Address of the first byte. */
    pointer: number;
    /** Length in bytes, without the terminating NUL. */
    length: number;
}
/** Reads and writes the module's linear memory. */
export declare class WasmMemory {
    #private;
    constructor(memory: WebAssembly.Memory, allocator: Allocator);
    /** A byte view over all of memory, valid until the next allocation. */
    bytes(): Uint8Array<ArrayBuffer>;
    /** A DataView over all of memory, valid until the next allocation. */
    view(): DataView;
    /** Decodes `length` bytes of UTF-8 at `pointer`. */
    readUtf8(pointer: number, length: number): string;
    /** Decodes the zero-terminated UTF-8 string at `pointer`; a null pointer reads as null. */
    readCString(pointer: number): string | null;
    /** Writes `text` plus a NUL into `capacity` bytes at `pointer`; returns false when it doesn't fit. */
    writeCString(pointer: number, capacity: number, text: string): boolean;
    /** Allocates `size` bytes with the module's malloc; throws when it returns NULL. */
    alloc(size: number): number;
    /** Frees a pointer from `alloc()` / `allocCString()` (a null pointer is ignored, like free()). */
    free(pointer: number): void;
    /** Copies `text` into newly allocated memory as a zero-terminated UTF-8 string. Free it with `free()`. */
    allocCString(text: string): CString;
}
