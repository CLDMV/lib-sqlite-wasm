/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/browser/drizzle.browser.vitest.mjs
 *	@Date: 2026-11-25T04:10:00-08:00 (1795608600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:20:59-08:00 (1795634459)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Drizzle on a browser main thread: the database lives in a module worker on OPFS, Drizzle talks to it through the
 * worker client. Runs the same scenarios as the Node tests, with the migrations bundled as data (the browser has no
 * file system for Drizzle's folder migrators).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle, migrate } from "../../src/drizzle.mts";
import client from "../../src/worker/client.mts";
import journal from "../drizzle/fixtures/migrations/meta/_journal.json";
import * as schema from "../drizzle/fixtures/schema.mjs";
import { defineSuite } from "../drizzle/suite.mjs";

// Drizzle's blob columns in "bigint", "buffer" and "json" modes call Node's Buffer when writing, and use it when
// reading if it exists. A browser has none, so apps that use those modes bring a Buffer polyfill; this is the
// smallest one Drizzle needs.
globalThis.Buffer ??= class Buffer extends Uint8Array {
	static isBuffer(value) {
		return value instanceof Buffer;
	}

	static from(input, offset, length) {
		if (typeof input === "string") return new Buffer(new TextEncoder().encode(input));
		if (input instanceof ArrayBuffer) return new Buffer(input, offset, length);
		return new Buffer(input);
	}

	toString() {
		return new TextDecoder().decode(this);
	}
};

const script = new URL("./fixtures/db-worker.mjs", import.meta.url);
const files = import.meta.glob("../drizzle/fixtures/migrations/*.sql", { query: "?raw", import: "default", eager: true });

/** The migrations folder as data. */
const bundled = {
	journal,
	migrations: Object.fromEntries(
		journal.entries.map((entry) => [`m${String(entry.idx).padStart(4, "0")}`, files[`../drizzle/fixtures/migrations/${entry.tag}.sql`]])
	)
};

let counter = 0;
const open = [];

beforeEach(async () => {
	const root = await navigator.storage.getDirectory();
	for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
});

afterEach(async () => {
	for (const db of open.splice(0)) await db.close();
});

/** Opens a fresh OPFS database in its own worker. */
async function connect(path = `drizzle-${++counter}.db`, options) {
	const raw = await client.connect(script, path, options);
	open.push(raw);
	return raw;
}

defineSuite({
	name: "drizzle in a browser on OPFS",
	sync: false,
	open: async () => {
		const raw = await connect();
		return { raw, close: () => raw.close() };
	},
	migrate: (db) => migrate(db, bundled)
});

describe("drizzle in a browser: persistence and batches", () => {
	it("keeps rows across a close and reopen of the OPFS file", async () => {
		const first = drizzle(await connect("keep.db"), { schema });
		await migrate(first, bundled);
		await first.insert(schema.users).values({ name: "ada", email: "ada@example.com", counter: 9007199254740993n, settings: { a: [1] } });
		await first.$client.close();

		const second = drizzle(await connect("keep.db"), { schema });
		await migrate(second, bundled);
		expect(
			await second.select({ name: schema.users.name, counter: schema.users.counter, settings: schema.users.settings }).from(schema.users)
		).toEqual([{ name: "ada", counter: 9007199254740993n, settings: { a: [1] } }]);
	});

	it("runs a batch atomically", async () => {
		const db = drizzle(await connect(), { schema });
		await migrate(db, bundled);
		const failed = await db
			.batch([
				db.insert(schema.users).values({ name: "ada", email: "ada@example.com" }),
				db.insert(schema.users).values({ name: "dup", email: "ada@example.com" })
			])
			.catch((thrown) => thrown);
		expect(failed).toBeInstanceOf(Error);
		expect(await db.$count(schema.users)).toBe(0);
		const [, rows] = await db.batch([
			db.insert(schema.users).values({ name: "ada", email: "ada@example.com" }),
			db.select({ name: schema.users.name }).from(schema.users)
		]);
		expect(rows).toEqual([{ name: "ada" }]);
	});
});
