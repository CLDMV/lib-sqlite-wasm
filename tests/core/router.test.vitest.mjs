/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/core/router.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:53-08:00 (1795600253)
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
import { codeName } from "../../src/core/codes.mts";
import { RouteConflict, VfsRouter } from "../../src/core/router.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";

describe("codeName", () => {
	it("names primary and extended codes", () => {
		expect(codeName(0)).toBe("SQLITE_OK");
		expect(codeName(2)).toBe("SQLITE_INTERNAL");
		expect(codeName(101)).toBe("SQLITE_DONE");
		expect(codeName(2067)).toBe("SQLITE_CONSTRAINT_UNIQUE");
		expect(codeName(10 | (23 << 8))).toBe("SQLITE_IOERR_DELETE_NOENT");
		expect(codeName(4 | (2 << 8))).toBe("SQLITE_ABORT_ROLLBACK");
		expect(codeName(5 | (3 << 8))).toBe("SQLITE_BUSY_TIMEOUT");
	});

	it("falls back to the primary name, or UNKNOWN", () => {
		expect(codeName(19 | (99 << 8))).toBe("SQLITE_CONSTRAINT");
		expect(codeName(2 | (1 << 8))).toBe("SQLITE_INTERNAL");
		expect(codeName(4 | (1 << 8))).toBe("SQLITE_ABORT");
		expect(codeName(77)).toBe("SQLITE_UNKNOWN");
	});
});

describe("VfsRouter", () => {
	it("routes names exactly, by prefix, and to the fallback", () => {
		const fallback = new MemoryDriver();
		const a = new MemoryDriver();
		const b = new MemoryDriver();
		const router = new VfsRouter(fallback);
		router.register("db", a);
		router.register("db-x", b);
		expect(router.route("db")).toBe(a);
		expect(router.route("db-journal")).toBe(a);
		expect(router.route("db-x-wal")).toBe(b);
		expect(router.route("dbx")).toBe(fallback);
		expect(router.route("d")).toBe(fallback);
		// The longest prefix wins whichever order the names were registered in.
		const reversed = new VfsRouter(fallback);
		reversed.register("db-x", b);
		reversed.register("db", a);
		expect(reversed.route("db-x-wal")).toBe(b);
		expect(reversed.route("db-y")).toBe(a);
	});

	it("registers the full pathname too, counts references and refuses conflicts", () => {
		const fallback = new MemoryDriver();
		const a = new MemoryDriver();
		a.fullPathname = (name) => `/abs/${name}`;
		const router = new VfsRouter(fallback);
		const first = router.register("x.db", a);
		const second = router.register("x.db", a);
		expect(router.route("/abs/x.db-wal")).toBe(a);
		expect(() => router.register("x.db", new MemoryDriver())).toThrow(RouteConflict);
		first();
		first();
		expect(router.route("x.db")).toBe(a);
		second();
		expect(router.route("x.db")).toBe(fallback);
		expect(router.route("/abs/x.db")).toBe(fallback);
	});

	it("forwards every file method to the driver that opened the file", () => {
		const fallback = new MemoryDriver();
		const a = new MemoryDriver();
		const router = new VfsRouter(fallback);
		router.register("f", a);
		expect(router.open("f", 1, 6)).toBe(0);
		expect(router.open(null, 2, 6)).toBe(0);
		expect(router.open("missing", 3, 2)).toBe(14);
		expect(router.write(1, new Uint8Array([1, 2, 3]), 0)).toBe(0);
		const target = new Uint8Array(3);
		expect(router.read(1, target, 0)).toBe(0);
		expect(target).toEqual(new Uint8Array([1, 2, 3]));
		expect(router.size(1)).toBe(3);
		expect(router.truncate(1, 1)).toBe(0);
		expect(router.sync(1, 0)).toBe(0);
		expect(router.lock(1, 1)).toBe(0);
		expect(router.checkReserved(1)).toBe(false);
		expect(router.unlock(1, 0)).toBe(0);
		expect(router.sectorSize(1)).toBe(4096);
		expect(router.deviceCharacteristics(1)).toBe(a.deviceCharacteristics());
		expect(router.access("f", 0)).toBe(true);
		expect(router.fullPathname("f")).toBe("f");
		expect(router.close(1)).toBe(0);
		expect(router.close(2)).toBe(0);
		expect(a.files()).toEqual(["f"]);
		expect(router.delete("f", false)).toBe(0);
		expect(a.files()).toEqual([]);
	});
});
