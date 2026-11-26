/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/drizzle/local.test.vitest.mjs
 *	@Date: 2026-11-25T03:40:00-08:00 (1795606800)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T18:24:26-08:00 (1795659866)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Drizzle over a synchronous sqlite-wasm database (what Node and a worker get): the shared scenarios on memory and
 * file storage, plus what only this wiring has: Drizzle's own better-sqlite3 migrator and logger options.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate as folder } from "drizzle-orm/better-sqlite3/migrator";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import sqlite from "../../src/index.mts";
import { drizzle, migrate } from "../../src/drizzle.mts";
import { bundled, folder as migrations } from "./fixtures/data.mjs";
import * as schema from "./fixtures/schema.mjs";
import { defineSuite } from "./suite.mjs";

let counter = 0;
const directories = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** A fresh in-memory database. */
async function memory() {
	const raw = await sqlite.open(`drizzle-${process.pid}-${++counter}.db`, { storage: "memory" });
	return { raw, close: () => raw.close() };
}

/** A fresh database file in a temporary directory. */
async function file() {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-wasm-drizzle-"));
	directories.push(directory);
	const raw = await sqlite.open(join(directory, "app.sqlite3"), { storage: "fs" });
	return { raw, close: () => raw.close() };
}

const apply = (db) => folder(db, { migrationsFolder: migrations });

defineSuite({ name: "drizzle on memory storage", sync: true, open: memory, migrate: apply });
defineSuite({
	name: "drizzle on file storage",
	sync: true,
	open: file,
	migrate: apply,
	extra(context) {
		it("keeps the data across a close and reopen", async () => {
			const { db } = context;
			const raw = db.$client;
			const path = raw.info.path;
			await db.insert(schema.users).values({ name: "ada", email: "ada@example.com", counter: 123n }).run();
			raw.close();
			const again = drizzle(await sqlite.open(path, { storage: "fs" }), { schema });
			expect(await again.select({ name: schema.users.name, counter: schema.users.counter }).from(schema.users).all()).toEqual([
				{ name: "ada", counter: 123n }
			]);
			again.$client.close();
		});
	}
});

describe("drizzle on a synchronous database", () => {
	it("migrates from bundled data, and only what is pending", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw, { schema });
		expect(migrate(db, { journal: { entries: bundled.journal.entries.slice(0, 1) }, migrations: bundled.migrations })).toBeUndefined();
		expect(db.all(sql`select name from pragma_table_info('posts') order by cid`).map((row) => row.name)).not.toContain("published");
		migrate(db, bundled);
		migrate(db, bundled);
		expect(db.all(sql`select name from pragma_table_info('posts') order by cid`).map((row) => row.name)).toContain("published");
		expect(db.values(sql`select count(*) from __drizzle_migrations`)).toEqual([[bundled.journal.entries.length]]);
		close();
	});

	it("migrates bundled data on top of a folder migration", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw, { schema });
		apply(db);
		migrate(db, bundled);
		expect(db.values(sql`select count(*) from __drizzle_migrations`)).toEqual([[bundled.journal.entries.length]]);
		close();
	});

	it("refuses bundled migrations with a missing file", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw);
		expect(() => migrate(db, { journal: bundled.journal, migrations: {} })).toThrow(/missing migration 0000_/);
		close();
	});

	it("works without a schema or options", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw);
		await db.run(sql`create table t (a integer)`);
		await db.run(sql`insert into t values (1)`);
		expect(await db.all(sql`select a from t`)).toEqual([{ a: 1 }]);
		expect(db.query).toEqual({});
		close();
	});

	it("logs queries when logger is true, a custom logger when given one, and nothing for false", async () => {
		const { raw, close } = await memory();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const verbose = drizzle(raw, { schema, logger: true });
		verbose.all(sql`select 1`);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Query: select 1"));
		log.mockClear();
		const queries = [];
		const custom = drizzle(raw, { schema, logger: { logQuery: (query, params) => queries.push([query, params]) } });
		custom.all(sql`select ${7} as n`);
		expect(queries).toEqual([["select ? as n", [7]]]);
		drizzle(raw, { logger: false }).all(sql`select 1`);
		expect(log).not.toHaveBeenCalled();
		close();
	});

	it("applies the casing option", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw, { casing: "snake_case" });
		db.run(sql`create table cased (user_id integer)`);
		const table = sqliteTable("cased", { userId: integer() });
		db.insert(table).values({ userId: 5 }).run();
		expect(db.values(sql`select user_id from cased`)).toEqual([[5]]);
		close();
	});

	it("rejects an async transaction callback, as better-sqlite3 does", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw);
		expect(() => db.transaction(async () => {})).toThrow(/must not return a promise/);
		close();
	});

	it("finalizes nothing it did not prepare: the database closes with statements outstanding", async () => {
		const { raw, close } = await memory();
		const db = drizzle(raw, { schema });
		db.run(sql`create table t (a)`);
		db.all(sql`select * from t`);
		close();
		expect(raw.info.open).toBe(false);
	});
});
