/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/core/vfs-imports.test.vitest.mjs
 *	@Date: 2026-11-25T01:10:29-08:00 (1795597829)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:16-08:00 (1795642216)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { createVfsImports, joinOffset } from "../../src/core/vfs-imports.mts";
import { WasmMemory } from "../../src/core/memory.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

/** Real WasmMemory over a standalone memory with a bump allocator. */
function testMemory() {
	let next = 8;
	const memory = new WasmMemory(new WebAssembly.Memory({ initial: 4 }), {
		malloc(size) {
			const pointer = next;
			next += (size + 7) & ~7;
			return pointer;
		},
		free() {}
	});
	return memory;
}

/** A driver whose every method throws. */
const throwing = new Proxy(
	{},
	{
		get: () => () => {
			throw new Error("boom");
		}
	}
);

describe("env.vfs_* imports", () => {
	it("joins split 64-bit offsets", () => {
		expect(joinOffset(5, 0)).toBe(5);
		expect(joinOffset(-1, 0)).toBe(0xffffffff);
		expect(joinOffset(0, 2)).toBe(2 * 2 ** 32);
	});

	it("turns driver exceptions into each method's error code", () => {
		const memory = testMemory();
		const errors = [];
		const vfs = createVfsImports(
			throwing,
			() => memory,
			(error) => errors.push(error.message)
		);
		const name = memory.allocCString("x.db").pointer;
		const out = memory.alloc(8);
		expect(vfs.vfs_open(name, 1, 6, out)).toBe(14); // SQLITE_CANTOPEN
		expect(vfs.vfs_delete(name, 0)).toBe(2570); // SQLITE_IOERR_DELETE
		expect(vfs.vfs_access(name, 0, out)).toBe(3338); // SQLITE_IOERR_ACCESS
		expect(vfs.vfs_fullpath(name, 64, out)).toBe(14);
		expect(vfs.vfs_read(1, out, 4, 0, 0)).toBe(266); // SQLITE_IOERR_READ
		expect(vfs.vfs_write(1, out, 4, 0, 0)).toBe(778); // SQLITE_IOERR_WRITE
		expect(vfs.vfs_truncate(1, 0, 0)).toBe(1546); // SQLITE_IOERR_TRUNCATE
		expect(vfs.vfs_sync(1, 0)).toBe(1034); // SQLITE_IOERR_FSYNC
		expect(vfs.vfs_size(1, out)).toBe(1802); // SQLITE_IOERR_FSTAT
		expect(vfs.vfs_lock(1, 1)).toBe(3850); // SQLITE_IOERR_LOCK
		expect(vfs.vfs_unlock(1, 0)).toBe(2058); // SQLITE_IOERR_UNLOCK
		expect(vfs.vfs_check_reserved(1, out)).toBe(3594); // SQLITE_IOERR_CHECKRESERVEDLOCK
		expect(vfs.vfs_close(1)).toBe(4106); // SQLITE_IOERR_CLOSE
		expect(vfs.vfs_sector_size(1)).toBe(4096);
		expect(vfs.vfs_device_characteristics(1)).toBe(0);
		expect(errors).toHaveLength(15);
		expect(new Set(errors)).toEqual(new Set(["boom"]));
	});

	it("dispatches to the driver and writes out-parameters", () => {
		const memory = testMemory();
		const driver = new MemoryDriver();
		const vfs = createVfsImports(
			driver,
			() => memory,
			() => {}
		);
		const name = memory.allocCString("db").pointer;
		const out = memory.alloc(16);
		const data = memory.allocCString("hello").pointer;
		const view = () => memory.view();

		expect(vfs.vfs_access(name, 0, out)).toBe(0);
		expect(view().getInt32(out, true)).toBe(0);
		expect(vfs.vfs_open(name, 1, 0x106, out)).toBe(0); // READWRITE | CREATE | MAIN_DB
		expect(view().getInt32(out, true)).toBe(0x106);
		expect(vfs.vfs_access(name, 0, out)).toBe(0);
		expect(view().getInt32(out, true)).toBe(1);

		expect(vfs.vfs_write(1, data, 5, 3, 0)).toBe(0);
		expect(vfs.vfs_size(1, out)).toBe(0);
		expect(view().getBigInt64(out, true)).toBe(8n);
		expect(vfs.vfs_read(1, out, 8, 0, 0)).toBe(0);
		expect(memory.readUtf8(out + 3, 5)).toBe("hello");
		expect(vfs.vfs_truncate(1, 4, 0)).toBe(0);
		expect(vfs.vfs_sync(1, 2)).toBe(0);
		expect(vfs.vfs_lock(1, 2)).toBe(0);
		expect(vfs.vfs_check_reserved(1, out)).toBe(0);
		expect(view().getInt32(out, true)).toBe(0);
		expect(vfs.vfs_unlock(1, 0)).toBe(0);
		expect(vfs.vfs_sector_size(1)).toBe(4096);
		expect(vfs.vfs_device_characteristics(1)).toBe(0x1200);
		expect(vfs.vfs_close(1)).toBe(0);
		expect(vfs.vfs_delete(name, 1)).toBe(0);
		expect(driver.files()).toEqual([]);

		// A failed open leaves no id mapping and no out-flags.
		view().setInt32(out, -1, true);
		expect(vfs.vfs_open(name, 2, 2, out)).toBe(14);
		expect(view().getInt32(out, true)).toBe(-1);
	});

	it("gives the driver process-wide file ids", () => {
		const memory = testMemory();
		const seen = [];
		const driver = new MemoryDriver();
		const open = driver.open.bind(driver);
		driver.open = (name, fileId, flags) => (seen.push(fileId), open(name, fileId, flags));
		const a = createVfsImports(
			driver,
			() => memory,
			() => {}
		);
		const b = createVfsImports(
			driver,
			() => memory,
			() => {}
		);
		const name = memory.allocCString("shared").pointer;
		const out = memory.alloc(8);
		a.vfs_open(name, 1, 6, out);
		b.vfs_open(name, 1, 6, out);
		expect(new Set(seen).size).toBe(2);
		a.vfs_lock(1, 2);
		expect(b.vfs_check_reserved(1, out)).toBe(0);
		expect(memory.view().getInt32(out, true)).toBe(1);
	});

	it("opens a temp file when SQLite passes no name", () => {
		const memory = testMemory();
		const driver = new MemoryDriver();
		const vfs = createVfsImports(
			driver,
			() => memory,
			() => {}
		);
		const out = memory.alloc(8);
		expect(vfs.vfs_open(0, 1, 6, out)).toBe(0);
		expect(driver.files()).toHaveLength(1);
		expect(vfs.vfs_close(1)).toBe(0);
		expect(driver.files()).toHaveLength(0);
	});

	it("refuses a full pathname that doesn't fit", () => {
		const memory = testMemory();
		const vfs = createVfsImports(
			new MemoryDriver(),
			() => memory,
			() => {}
		);
		const name = memory.allocCString("0123456789").pointer;
		const out = memory.alloc(16);
		expect(vfs.vfs_fullpath(name, 10, out)).toBe(14);
		expect(vfs.vfs_fullpath(name, 11, out)).toBe(0);
		expect(memory.readCString(out)).toBe("0123456789");
	});

	it("fills randomness in chunks crypto.getRandomValues accepts", () => {
		const memory = testMemory();
		const vfs = createVfsImports(
			new MemoryDriver(),
			() => memory,
			() => {}
		);
		const out = memory.alloc(70000);
		expect(vfs.vfs_randomness(70000, out)).toBe(70000);
		expect(
			memory
				.bytes()
				.subarray(out + 65536, out + 70000)
				.some((byte) => byte !== 0)
		).toBe(true);
	});

	it("reports the time as Julian milliseconds and sleeps", () => {
		const memory = testMemory();
		const vfs = createVfsImports(
			new MemoryDriver(),
			() => memory,
			() => {}
		);
		const out = memory.alloc(8);
		expect(vfs.vfs_current_time_ms(out)).toBe(0);
		const julianDay = Number(memory.view().getBigInt64(out, true)) / 86400000;
		expect(Math.abs(julianDay - (Date.now() / 86400000 + 2440587.5))).toBeLessThan(0.001);
		const started = performance.now();
		expect(vfs.vfs_sleep(20000)).toBe(20000);
		expect(performance.now() - started).toBeGreaterThanOrEqual(15);
	});
});
