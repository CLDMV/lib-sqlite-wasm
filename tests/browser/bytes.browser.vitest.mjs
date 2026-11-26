/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/browser/bytes.browser.vitest.mjs
 *	@Date: 2026-11-25T18:21:58-08:00 (1795659718)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T18:24:25-08:00 (1795659865)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview `bytes()` in a browser with no `Buffer` at all: this file deliberately installs no polyfill, which is
 * the case `bytes()` exists for.
 */
import { asc, eq } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytes, drizzle } from "../../src/drizzle.mts";
import client from "../../src/worker/client.mts";

const files = sqliteTable("files", { id: integer("id").primaryKey(), data: bytes("data") });
const script = new URL("./fixtures/db-worker.mjs", import.meta.url);
let raw;

beforeEach(async () => {
	const root = await navigator.storage.getDirectory();
	for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
	raw = await client.connect(script, "bytes.db");
	await raw.exec("create table files (id integer primary key, data blob)");
});

afterEach(async () => {
	await raw.close();
});

describe("bytes() without a Buffer polyfill", () => {
	it("runs in a page with no Buffer", () => {
		expect(globalThis.Buffer).toBeUndefined();
	});

	it("writes and reads Uint8Array values through the worker client", async () => {
		const db = drizzle(raw);
		await db
			.insert(files)
			.values([{ id: 1, data: new Uint8Array([0, 255, 7]) }, { id: 2 }])
			.run();
		const rows = await db.select().from(files).orderBy(asc(files.id)).all();
		expect(rows[0].data).toBeInstanceOf(Uint8Array);
		expect([...rows[0].data]).toEqual([0, 255, 7]);
		expect(rows[1].data).toBeNull();
		await db
			.update(files)
			.set({ data: new Uint8Array([9]) })
			.where(eq(files.id, 2))
			.run();
		expect([...(await db.select().from(files).where(eq(files.id, 2)).get()).data]).toEqual([9]);
		expect(globalThis.Buffer).toBeUndefined();
	});
});
