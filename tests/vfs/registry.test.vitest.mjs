/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/registry.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:53-08:00 (1795600253)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:50:53-08:00 (1795600253)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { error } from "../../src/api/error.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";
import { detect, install, isStorage, load, sharedMemory } from "../../src/vfs/registry.mts";

const options = { path: "x.db", readonly: false, create: true, timeout: 0 };

describe("storage registry", () => {
	it("detects the storage auto means", () => {
		expect(detect()).toBe("fs");
		expect(detect({ process: { versions: { node: "26.0.0" } } })).toBe("fs");
		expect(detect({ process: {}, FileSystemSyncAccessHandle: class {} })).toBe("opfs");
		expect(detect({})).toBe("memory");
	});

	it("knows the storage names", () => {
		for (const name of ["auto", "memory", "fs", "opfs"]) expect(isStorage(name)).toBe(true);
		for (const name of ["disk", "hasOwnProperty", 1, undefined]) expect(isStorage(name)).toBe(false);
	});

	it("loads the shared memory driver", async () => {
		expect(await load("memory", options)).toBe(sharedMemory());
		expect(sharedMemory()).toBeInstanceOf(MemoryDriver);
	});

	it("fails clearly for drivers not in this build", async () => {
		for (const kind of ["fs", "opfs"]) {
			const failure = await load(kind, options).then(
				() => undefined,
				(caught) => caught
			);
			expect(failure).toBeInstanceOf(error);
			expect(failure).toMatchObject({ code: "SQLITE_CANTOPEN", message: `storage "${kind}" is not available in this build` });
		}
	});

	it("lets a loader be swapped and restored", async () => {
		const driver = new MemoryDriver();
		const seen = [];
		const previous = install("opfs", async () => ({ create: async (given) => (seen.push(given), driver) }));
		expect(await load("opfs", options)).toBe(driver);
		expect(seen).toEqual([options]);
		install("opfs", previous);
		await expect(load("opfs", options)).rejects.toThrow(/not available/);
	});
});
