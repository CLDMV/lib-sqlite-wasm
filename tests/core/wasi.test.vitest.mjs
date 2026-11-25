/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/core/wasi.test.vitest.mjs
 *	@Date: 2026-11-25T01:11:07-08:00 (1795597867)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:06-08:00 (1795598286)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { createWasiImports, WASI_MODULE } from "../../src/core/wasi.mts";
import { WasmMemory } from "../../src/core/memory.mts";

const memory = new WasmMemory(new WebAssembly.Memory({ initial: 1 }), { malloc: () => 0, free: () => {} });
const wasi = createWasiImports(() => memory);

describe("WASI shims", () => {
	it("use the wasip1 module name and provide only random_get", () => {
		expect(WASI_MODULE).toBe("wasi_snapshot_preview1");
		expect(Object.keys(wasi)).toEqual(["random_get"]);
	});

	it("fill random bytes", () => {
		memory.bytes().fill(0, 64, 128);
		expect(wasi.random_get(64, 64)).toBe(0);
		expect(
			memory
				.bytes()
				.subarray(64, 128)
				.some((byte) => byte !== 0)
		).toBe(true);
	});
});
