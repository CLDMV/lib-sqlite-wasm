/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/vfs/memory.test.vitest.mjs
 *	@Date: 2026-11-25T01:10:29-08:00 (1795597829)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:18-08:00 (1795642218)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { MemoryDriver } from "../../src/vfs/memory.mts";
import { WasmMemory } from "../../src/core/memory.mts";

const CREATE = 0x4 | 0x2;
const DELETE_ON_CLOSE = 0x8;
const [NONE, SHARED, RESERVED, PENDING, EXCLUSIVE] = [0, 1, 2, 3, 4];
const BUSY = 5;

describe("MemoryDriver", () => {
	it("creates files only with SQLITE_OPEN_CREATE", () => {
		const driver = new MemoryDriver();
		expect(driver.open("a", 1, 2)).toBe(14);
		expect(driver.open("a", 1, CREATE)).toBe(0);
		expect(driver.open("a", 2, 2)).toBe(0);
		expect(driver.access("a", 0)).toBe(true);
		expect(driver.access("b", 0)).toBe(false);
		expect(driver.fullPathname("a")).toBe("a");
		expect(driver.contents("b")).toBeUndefined();
	});

	it("reads, writes, grows, truncates and zero-fills short reads", () => {
		const driver = new MemoryDriver();
		driver.open("f", 1, CREATE);
		expect(driver.write(1, new Uint8Array([1, 2, 3]), 0)).toBe(0);
		expect(driver.write(1, new Uint8Array([9]), 10)).toBe(0);
		expect(driver.size(1)).toBe(11);
		expect(driver.write(1, new Uint8Array([7]), 1)).toBe(0);
		expect(driver.contents("f")).toEqual(new Uint8Array([1, 7, 3, 0, 0, 0, 0, 0, 0, 0, 9]));

		const target = new Uint8Array(4).fill(0xee);
		expect(driver.read(1, target, 9)).toBe(522); // SQLITE_IOERR_SHORT_READ
		expect(target).toEqual(new Uint8Array([0, 9, 0, 0]));
		target.fill(0xee);
		expect(driver.read(1, target, 100)).toBe(522);
		expect(target).toEqual(new Uint8Array(4));
		expect(driver.read(1, target, 0)).toBe(0);
		expect(target).toEqual(new Uint8Array([1, 7, 3, 0]));

		expect(driver.truncate(1, 2)).toBe(0);
		expect(driver.truncate(1, 50)).toBe(0); // never grows
		expect(driver.size(1)).toBe(2);
		expect(driver.write(1, new Uint8Array([5]), 4)).toBe(0);
		expect(driver.contents("f")).toEqual(new Uint8Array([1, 7, 0, 0, 5]));
		expect(driver.sync(1, 0)).toBe(0);
		expect(driver.sectorSize(1)).toBe(4096);
	});

	it("deletes files, reporting a missing one", () => {
		const driver = new MemoryDriver();
		driver.open("f", 1, CREATE);
		driver.close(1);
		expect(driver.delete("f", false)).toBe(0);
		expect(driver.delete("f", false)).toBe(5898); // SQLITE_IOERR_DELETE_NOENT
	});

	it("removes delete-on-close and anonymous files when closed, but not a newer file of the same name", () => {
		const driver = new MemoryDriver();
		driver.open("t", 1, CREATE | DELETE_ON_CLOSE);
		driver.open(null, 2, CREATE);
		expect(driver.files()).toEqual(["t", "temp-2"]);
		driver.close(1);
		driver.close(2);
		expect(driver.files()).toEqual([]);

		driver.open("t", 3, CREATE | DELETE_ON_CLOSE);
		driver.delete("t", false);
		driver.open("t", 4, CREATE);
		driver.close(3);
		expect(driver.files()).toEqual(["t"]);
	});

	it("throws for an unknown file id", () => {
		expect(() => new MemoryDriver().size(99)).toThrow("memory driver: no open file with id 99");
	});

	it("tracks lock levels between handles", () => {
		const driver = new MemoryDriver();
		driver.open("db", 1, CREATE);
		driver.open("db", 2, CREATE);
		expect(driver.lock(1, SHARED)).toBe(0);
		expect(driver.lock(2, SHARED)).toBe(0);
		expect(driver.lock(1, RESERVED)).toBe(0);
		expect(driver.checkReserved(2)).toBe(true);
		expect(driver.checkReserved(1)).toBe(false);
		expect(driver.lock(2, RESERVED)).toBe(BUSY);
		expect(driver.lock(1, EXCLUSIVE)).toBe(BUSY); // handle 2 still reads
		expect(driver.unlock(2, NONE)).toBe(0);
		expect(driver.lock(1, PENDING)).toBe(0);
		expect(driver.lock(2, SHARED)).toBe(BUSY); // no new readers while a writer waits
		expect(driver.lock(1, EXCLUSIVE)).toBe(0);
		expect(driver.unlock(1, SHARED)).toBe(0);
		expect(driver.lock(2, SHARED)).toBe(0);
		driver.close(1);
		expect(driver.lock(2, EXCLUSIVE)).toBe(0);
	});
});

describe("WasmMemory", () => {
	const memory = new WebAssembly.Memory({ initial: 1 });

	it("throws when malloc returns NULL", () => {
		const wasm = new WasmMemory(memory, { malloc: () => 0, free: () => {} });
		expect(() => wasm.alloc(10)).toThrow("sqlite-wasm: out of memory allocating 10 bytes");
	});

	it("reads a null pointer as null and hands free() through", () => {
		const freed = [];
		const wasm = new WasmMemory(memory, { malloc: () => 16, free: (pointer) => freed.push(pointer) });
		expect(wasm.readCString(0)).toBeNull();
		const { pointer, length } = wasm.allocCString("ü");
		expect([pointer, length]).toEqual([16, 2]);
		expect(wasm.readCString(pointer)).toBe("ü");
		wasm.free(pointer);
		expect(freed).toEqual([16]);
	});
});
