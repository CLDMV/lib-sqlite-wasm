/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/fs-helpers.mjs
 *	@Date: 2026-11-25T01:49:24-08:00 (1795600164)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:21:01-08:00 (1795634461)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Shared helpers for the node-fs driver tests: temporary directories, opening a database on the driver
 * with the journal settings the public API will apply, and child processes that hold or crash a database.
 *
 * The public Database API isn't available yet, so this opens through the low-level `openRaw()` helper with the fs
 * driver plugged in and runs the open-time pragmas itself.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRaw } from "../../src/core/raw.mts";
import { create } from "../../src/vfs/fs.mts";

/** The child-process script. */
export const CHILD = fileURLToPath(new URL("./fs-child.mjs", import.meta.url));

/** Makes a fresh temporary directory; `cleanup()` removes every one made so far. */
const made = [];
export function scratch() {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-wasm-fs-"));
	made.push(directory);
	return directory;
}
export function cleanup() {
	for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** The pragmas the public API runs at open for each journal mode (DESIGN.md, "WAL without shared memory"). */
export function pragmas(journal) {
	return journal === "wal"
		? "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;"
		: `PRAGMA journal_mode = ${journal}; PRAGMA foreign_keys = ON;`;
}

/** Opens `path` on the fs driver and applies the journal mode (WAL unless told otherwise). */
export async function open(path, { journal = "wal", timeout = 5000, driver = create({ timeout }) } = {}) {
	const db = await openRaw(path, { driver });
	try {
		db.exec(pragmas(journal));
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

/** A pid that belonged to a process on this host which has already exited. */
export function deadPid() {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** Writes a lock directory at `directory` owned by `owner` (defaults: a dead pid on this host). */
export function plantLock(directory, owner = {}) {
	mkdirSync(directory, { recursive: true });
	const record = { pid: deadPid(), hostname: hostname(), started: new Date(0).toISOString(), ...owner };
	writeFileSync(join(directory, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(record));
	return record;
}

/**
 * Starts `node fs-child.mjs <args>` and returns the process with `next()`, which resolves with each stdout line in
 * turn, and `exited`, which resolves with { code, signal }.
 */
export function child(...args) {
	const proc = spawn(process.execPath, [CHILD, ...args.map(String)], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = [];
	const waiting = [];
	let buffer = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			const resolve = waiting.shift();
			if (resolve) resolve(line);
			else lines.push(line);
		}
	});
	const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
	return {
		proc,
		exited,
		next() {
			if (lines.length) return Promise.resolve(lines.shift());
			return new Promise((resolve, reject) => {
				waiting.push(resolve);
				exited.then(({ code, signal }) => reject(new Error(`child exited (${code ?? signal}) before printing a line`)));
			});
		},
		send(line) {
			proc.stdin.write(`${line}\n`);
		}
	};
}
