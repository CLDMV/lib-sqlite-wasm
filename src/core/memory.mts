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

/**
 * @fileoverview Access to the module's linear memory: fresh views, C strings and allocation.
 *
 * Views are created on every call because `memory.grow()` (any malloc can trigger it) detaches the old ArrayBuffer.
 * Strings are UTF-8 in both directions.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
export class WasmMemory {
	readonly #memory: WebAssembly.Memory;
	readonly #allocator: Allocator;

	constructor(memory: WebAssembly.Memory, allocator: Allocator) {
		this.#memory = memory;
		this.#allocator = allocator;
	}

	/** A byte view over all of memory, valid until the next allocation. */
	bytes(): Uint8Array<ArrayBuffer> {
		return new Uint8Array(this.#memory.buffer);
	}

	/** A DataView over all of memory, valid until the next allocation. */
	view(): DataView {
		return new DataView(this.#memory.buffer);
	}

	/** Decodes `length` bytes of UTF-8 at `pointer`. */
	readUtf8(pointer: number, length: number): string {
		return decoder.decode(this.bytes().subarray(pointer, pointer + length));
	}

	/** Decodes the zero-terminated UTF-8 string at `pointer`; a null pointer reads as null. */
	readCString(pointer: number): string | null {
		if (pointer === 0) return null;
		const bytes = this.bytes();
		const end = bytes.indexOf(0, pointer);
		return decoder.decode(bytes.subarray(pointer, end));
	}

	/** Writes `text` plus a NUL into `capacity` bytes at `pointer`; returns false when it doesn't fit. */
	writeCString(pointer: number, capacity: number, text: string): boolean {
		const encoded = encoder.encode(text);
		if (encoded.length + 1 > capacity) return false;
		const bytes = this.bytes();
		bytes.set(encoded, pointer);
		bytes[pointer + encoded.length] = 0;
		return true;
	}

	/** Allocates `size` bytes with the module's malloc; throws when it returns NULL. */
	alloc(size: number): number {
		const pointer = this.#allocator.malloc(size);
		if (pointer === 0) throw new RangeError(`sqlite-wasm: out of memory allocating ${size} bytes`);
		return pointer;
	}

	/** Frees a pointer from `alloc()` / `allocCString()` (a null pointer is ignored, like free()). */
	free(pointer: number): void {
		this.#allocator.free(pointer);
	}

	/** Copies `text` into newly allocated memory as a zero-terminated UTF-8 string. Free it with `free()`. */
	allocCString(text: string): CString {
		const encoded = encoder.encode(text);
		const pointer = this.alloc(encoded.length + 1);
		const bytes = this.bytes();
		bytes.set(encoded, pointer);
		bytes[pointer + encoded.length] = 0;
		return { pointer, length: encoded.length };
	}
}
