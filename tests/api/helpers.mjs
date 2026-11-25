/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/api/helpers.mjs
 *	@Date: 2026-11-25T01:45:57-08:00 (1795599957)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:45:57-08:00 (1795599957)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Shared helpers for the API tests.
 */
import sqlite from "../../src/index.mts";
import { connections } from "../../src/api/database.mts";
import { sharedMemory } from "../../src/vfs/registry.mts";

let counter = 0;

/** A database name no other test in the file uses. */
export function unique(label = "db") {
	return `${label}-${process.pid}-${++counter}.db`;
}

/** Opens a fresh memory database (or `name`) and returns it. */
export function memory(name = unique(), options = {}) {
	return sqlite.open(name, { storage: "memory", ...options });
}

/** Runs `body` and returns what it threw (fails the test when it doesn't throw). */
export function thrown(body) {
	try {
		body();
	} catch (caught) {
		return caught;
	}
	throw new Error("expected an exception");
}

/** Awaits `promise` and returns its rejection reason (fails the test when it resolves). */
export async function rejected(promise) {
	try {
		await promise;
	} catch (caught) {
		return caught;
	}
	throw new Error("expected a rejection");
}

/** The internal connection state of a database. */
export function connection(db) {
	return connections.get(db);
}

/** Names of the files the process-wide memory driver holds that start with `prefix`. */
export function files(prefix) {
	return sharedMemory()
		.files()
		.filter((name) => name.startsWith(prefix))
		.sort();
}

export { sqlite };
