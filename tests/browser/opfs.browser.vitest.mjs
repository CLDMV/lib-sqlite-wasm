/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/browser/opfs.browser.vitest.mjs
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * OPFS and the worker client in a real browser: each test starts module workers running the host, which open
 * databases in the origin's private file system through sync access handles.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import client from "../../src/worker/client.mts";

const script = new URL("./fixtures/db-worker.mjs", import.meta.url);
const open = [];

/** Connects through a new worker; closed after the test. */
async function connect(path, options) {
	const db = await client.connect(script, path, options);
	open.push(db);
	return db;
}

/** Names at the top of the origin's OPFS. */
async function names() {
	const root = await navigator.storage.getDirectory();
	const found = [];
	for await (const name of root.keys()) found.push(name);
	return found.sort();
}

beforeEach(async () => {
	const root = await navigator.storage.getDirectory();
	for (const name of await names()) await root.removeEntry(name, { recursive: true });
});

afterEach(async () => {
	for (const db of open.splice(0)) await db.close();
});

describe("OPFS in a worker", () => {
	for (const journal of ["wal", "truncate"]) {
		it(`creates, writes, closes and reopens a database in ${journal} mode`, async () => {
			const db = await connect(`${journal}.db`, { journal });
			expect(db.info).toMatchObject({ path: `/${journal}.db`, storage: "opfs" });
			expect(await db.pragma.get("journal_mode")).toBe(journal);
			await db.execute("create table t(id integer primary key, a text)");
			await db.transaction((tx) => {
				const insert = tx.prepare("insert into t(a) values (?)");
				for (let index = 0; index < 500; index++) insert.run(`row ${index}`);
			});
			await db.close();
			expect(await names()).toEqual([`${journal}.db`]);

			const again = await connect(`${journal}.db`, { journal });
			expect(await again.prepare("select count(*) from t").pluck.get()).toBe(500);
			expect(await again.prepare("pragma integrity_check").pluck.get()).toBe("ok");
		});
	}

	it("refuses a database another tab (here: another worker) has open, until it is closed", async () => {
		const first = await connect("shared.db");
		const failure = await client.connect(script, "shared.db").catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(client.error);
		expect(failure).toMatchObject({ code: "SQLITE_BUSY", number: 5 });
		expect(failure.message).toMatch(/open in another tab/);
		await first.close();
		const second = await connect("shared.db");
		expect(second.info.open).toBe(true);
	});

	it("rolls back a transaction that throws", async () => {
		const db = await connect("rollback.db");
		await db.execute("create table t(a)");
		await expect(
			db.transaction(async (tx) => {
				await tx.execute("insert into t values (1)");
				throw new Error("undo");
			})
		).rejects.toThrow("undo");
		expect(await db.prepare("select count(*) from t").pluck.get()).toBe(0);
	});
});

describe("worker client", () => {
	it("round-trips values and errors", async () => {
		const db = await connect("values.db");
		await db.execute("create table t(a unique, b)");
		const insert = db.prepare("insert into t values (?, ?)");
		expect(await insert.run(1, new Uint8Array([1, 2, 3]))).toEqual({ changes: 1, rowid: 1 });
		expect(await insert.run(9007199254740993n, "text")).toEqual({ changes: 1, rowid: 2 });
		expect(await db.prepare("select a, b from t order by rowid").all()).toEqual([
			{ a: 1, b: new Uint8Array([1, 2, 3]) },
			{ a: 9007199254740993n, b: "text" }
		]);
		const failure = await insert.run(1, null).catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(client.error);
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", sql: "insert into t values (?, ?)" });
	});

	it("serves the drizzle sqlite-proxy shape", async () => {
		const db = await connect("proxy.db");
		expect(await db.proxy("create table t(a, b)", [], "run")).toEqual({ rows: [] });
		expect(await db.proxy("insert into t values (?, ?)", [1, "x"], "run")).toEqual({ rows: [] });
		expect(await db.proxy("select a, b from t", [], "get")).toEqual({ rows: [1, "x"] });
		expect(await db.proxy("select a, b from t where a = 2", [], "get")).toEqual({ rows: null });
		expect(await db.proxy("select a, b from t", [], "all")).toEqual({ rows: [[1, "x"]] });
		expect(await db.proxy("select a, b from t", [], "values")).toEqual({ rows: [[1, "x"]] });
	});
});
