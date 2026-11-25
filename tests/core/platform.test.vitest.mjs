/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/core/platform.test.vitest.mjs
 *	@Date: 2026-11-25T09:00:00-08:00 (1795626000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T09:00:00-08:00 (1795626000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Without the Node capabilities (the browser entries never load src/node.mts), every Node-only path fails with an
 * error that says so instead of reaching a `node:` module.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { node, provide } from "../../src/core/platform.mts";
import { readWasm } from "../../src/core/loader.mts";
import { install, load } from "../../src/vfs/registry.mts";
import sqlite from "../../src/index.mts";

let saved;
const cleanup = [];

afterEach(() => {
	if (saved) provide(saved);
	saved = undefined;
	for (const undo of cleanup.splice(0)) undo();
});

describe("Node capabilities", () => {
	it("are provided by src/node.mts and can be swapped", () => {
		const current = node("anything");
		expect(Object.keys(current).sort()).toEqual(["fs", "processes", "read"]);
		saved = provide(undefined);
		expect(saved).toBe(current);
		expect(provide(saved)).toBeUndefined();
		saved = undefined;
	});

	it("say which feature needs Node when they are missing", async () => {
		await sqlite.open("warm.db", { storage: "memory" }).then((db) => db.close());
		saved = provide(undefined);
		await expect(readWasm(new URL("../../dist/", import.meta.url))).rejects.toThrow(/reading sqlite3\.wasm from disk needs Node\.js/);
		await expect(load("fs", {})).rejects.toMatchObject({
			code: "SQLITE_CANTOPEN",
			message: expect.stringMatching(/storage "fs" needs Node\.js/)
		});
		// The node-fs driver itself, put back directly, to reach the "db" lock's process check.
		const previous = install("fs", saved.fs);
		const dir = mkdtempSync(join(tmpdir(), "sqlite-platform-"));
		cleanup.push(
			() => install("fs", previous),
			() => rmSync(dir, { recursive: true, force: true })
		);
		await expect(sqlite.open(join(dir, "x.db"), { storage: "fs", lock: "db", journal: "delete" })).rejects.toThrow(
			/the "db" lock needs Node\.js/
		);
	});
});
