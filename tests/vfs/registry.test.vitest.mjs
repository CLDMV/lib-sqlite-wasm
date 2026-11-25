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
		for (const scope of [{}, { process: {} }]) {
			let caught;
			try {
				detect(scope);
			} catch (thrown) {
				caught = thrown;
			}
			expect(caught).toBeInstanceOf(error);
			expect(caught.code).toBe("SQLITE_CANTOPEN");
			expect(caught.message).toMatch(/dedicated browser worker.*storage: "memory"/);
		}
	});

	it("knows the storage names", () => {
		for (const name of ["auto", "memory", "fs", "opfs"]) expect(isStorage(name)).toBe(true);
		for (const name of ["disk", "hasOwnProperty", 1, undefined]) expect(isStorage(name)).toBe(false);
	});

	it("loads the shared memory driver", async () => {
		expect(await load("memory", options)).toBe(sharedMemory());
		expect(sharedMemory()).toBeInstanceOf(MemoryDriver);
	});

	it("loads the node-fs and OPFS driver modules", async () => {
		const fs = await load("fs", options);
		expect(typeof fs.open).toBe("function");
		const opfs = await load("opfs", options);
		expect(typeof opfs.prepare).toBe("function");
		// No OPFS in Node: the driver loads, preparing a file fails clearly.
		await expect(opfs.prepare("x.db", options)).rejects.toMatchObject({
			code: "SQLITE_CANTOPEN",
			message: expect.stringMatching(/OPFS is not available/)
		});
	});

	it("turns a driver module that can't load here into a clear error", async () => {
		const missing = new Error("Cannot find module 'node:fs'");
		const previous = install("fs", () => Promise.reject(missing));
		const failure = await load("fs", options).then(
			() => undefined,
			(caught) => caught
		);
		install("fs", previous);
		expect(failure).toBeInstanceOf(error);
		expect(failure).toMatchObject({
			code: "SQLITE_CANTOPEN",
			message: `storage "fs" is not available here: ${missing.message}`,
			cause: missing
		});
		// An sqlite.error from a loader passes through unchanged.
		const own = new error("nope", 14);
		const opfs = install("opfs", () => Promise.reject(own));
		await expect(load("opfs", options)).rejects.toBe(own);
		install("opfs", opfs);
	});

	it("lets a loader be swapped and restored", async () => {
		const driver = new MemoryDriver();
		const seen = [];
		const previous = install("opfs", async () => ({ create: async (given) => (seen.push(given), driver) }));
		expect(await load("opfs", options)).toBe(driver);
		expect(seen).toEqual([options]);
		install("opfs", previous);
		expect(await load("opfs", options)).not.toBe(driver);
	});
});
