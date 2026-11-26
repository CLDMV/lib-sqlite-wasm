/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/drizzle/remote.test.vitest.mjs
 *	@Date: 2026-11-25T03:50:00-08:00 (1795607400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:17-08:00 (1795642217)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Drizzle over the worker client (the main-thread setup): the host runs behind a MessageChannel instead of a worker,
 * with the real sqlite3.wasm. The shared scenarios, then what only the proxy wiring has: batches, queued transactions,
 * migrations through `sqlite-proxy`'s migrator, and Drizzle's own `sqlite-proxy` driver on `db.proxy`. The shared
 * scenarios also run on a follower tab of a shared connection (`share: true`), with fake tabs on the OPFS fake.
 */
import { asc, count, eq, sql } from "drizzle-orm";
import { drizzle as proxied } from "drizzle-orm/sqlite-proxy";
import { migrate as through } from "drizzle-orm/sqlite-proxy/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle, migrate } from "../../src/drizzle.mts";
import { loadSqliteModule } from "../../src/core/loader.mts";
import { connect } from "../../src/worker/client.mts";
import { listen } from "../../src/worker/host.mts";
import { fakedirectory, fakelocks } from "../fakes/opfs.mjs";
import { fakeorigin } from "../fakes/tabs.mjs";
import { bundled, folder } from "./fixtures/data.mjs";
import * as schema from "./fixtures/schema.mjs";
import { defineSuite } from "./suite.mjs";

const { users, posts } = schema;
const module = await loadSqliteModule();
let counter = 0;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A fresh in-memory database behind a client. */
async function open() {
	const { port1, port2 } = new MessageChannel();
	listen(port2, { wasm: module });
	const raw = await connect(port1, `drizzle-remote-${process.pid}-${++counter}.db`, { storage: "memory" });
	return {
		raw,
		close: async () => {
			await raw.close();
			port1.close();
			port2.close();
		}
	};
}

/** A fresh OPFS database shared by two fake tabs; Drizzle runs on the follower, the leader's tab runs the worker. */
async function shared() {
	const root = new fakedirectory();
	const locks = fakelocks();
	const origin = fakeorigin((port, worker) => {
		const routed = { request: (name, ...rest) => (name.startsWith("sqlite:") ? worker.locks : locks).request(name, ...rest) };
		listen(port, { wasm: module, root, locks: routed });
		return (side) => side.postMessage({ id: 0, tx: false, calls: [{ op: "close" }] });
	});
	const path = `drizzle-shared-${process.pid}-${++counter}.db`;
	/** Connects from `tab`; the page's globals are read synchronously, so they are only stubbed for the call. */
	const join = (tab) => {
		vi.stubGlobal("navigator", tab.navigator);
		vi.stubGlobal("BroadcastChannel", tab.BroadcastChannel);
		vi.stubGlobal("Worker", tab.Worker);
		try {
			return connect("https://app.test/db-worker.mjs", path, { share: true, timeout: 2000 });
		} finally {
			vi.unstubAllGlobals();
		}
	};
	const leader = await join(origin.tab());
	const raw = await join(origin.tab());
	return {
		raw,
		close: async () => {
			await raw.close();
			await leader.close();
			for (const port of origin.ports) port.close();
		}
	};
}

/** Drizzle's sqlite-proxy migrator, running the queries it plans as one client transaction. */
const apply = (db) =>
	through(
		db,
		(queries) =>
			db.$client.transaction((tx) => {
				for (const query of queries) tx.execute(query);
			}),
		{ migrationsFolder: folder }
	);

defineSuite({
	name: "drizzle over the worker client",
	sync: false,
	open,
	migrate: apply,
	extra(context) {
		it("returns promises", () => {
			const pending = context.db.select().from(users).all();
			expect(pending).toBeInstanceOf(Promise);
			return pending;
		});
	}
});

defineSuite({
	name: "drizzle over a shared client, from a follower tab",
	sync: false,
	open: shared,
	migrate: apply,
	extra(context) {
		it("runs on a follower", () => {
			expect(context.raw.info.leader).toBe(false);
		});
	}
});

describe("drizzle over the worker client: batches", () => {
	it("runs a batch as one transaction and returns each result in shape", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		await migrate(db, bundled);
		const [inserted, listed, one, none, counted] = await db.batch([
			db.insert(users).values([
				{ name: "ada", email: "ada@example.com" },
				{ name: "bob", email: "bob@example.com" }
			]),
			db.select({ name: users.name }).from(users).orderBy(asc(users.id)),
			db.select().from(users).where(eq(users.id, 2)).limit(1),
			db.query.users.findFirst({ where: eq(users.id, 99) }),
			db.select({ n: count() }).from(users)
		]);
		expect(inserted).toBeDefined();
		expect(listed).toEqual([{ name: "ada" }, { name: "bob" }]);
		expect(one).toHaveLength(1);
		expect(one[0].name).toBe("bob");
		expect(none).toBeUndefined();
		expect(counted).toEqual([{ n: 2 }]);
		await close();
	});

	it("undoes the whole batch when one query fails", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		await migrate(db, bundled);
		await db.insert(users).values({ name: "ada", email: "ada@example.com" });
		const failure = await db
			.batch([
				db.insert(users).values({ name: "bob", email: "bob@example.com" }),
				db.insert(users).values({ name: "dup", email: "ada@example.com" })
			])
			.catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(Error);
		expect(await db.$count(users)).toBe(1);
		await close();
	});

	it("sends a batch to the worker as one transaction message and a commit", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		await migrate(db, bundled);
		const post = vi.spyOn(MessagePort.prototype, "postMessage");
		await db.batch([
			db.insert(users).values({ name: "ada", email: "ada@example.com" }),
			db.insert(users).values({ name: "bob", email: "bob@example.com" }),
			db.insert(users).values({ name: "cy", email: "cy@example.com" })
		]);
		// Two requests (the statements with BEGIN, then COMMIT) and their two replies, whatever the batch size.
		expect(post.mock.calls.length).toBeLessThanOrEqual(4);
		await close();
	});
});

describe("drizzle over the worker client: transactions", () => {
	it("runs concurrent transactions one after another instead of interleaving them", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		await migrate(db, bundled);
		const add = (name) =>
			db.transaction(async (tx) => {
				await tx.insert(users).values({ name, email: `${name}@example.com` });
				await tx.insert(posts).values({ author: sql`(select id from users where name = ${name})`, title: name });
			});
		await Promise.all([add("ada"), add("bob"), add("cy")]);
		expect(await db.$count(users)).toBe(3);
		expect(await db.$count(posts)).toBe(3);
		expect(raw.info.transaction).toBe(false);
		await close();
	});

	it("keeps going after one transaction rolled back", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		await migrate(db, bundled);
		const failing = db
			.transaction(async (tx) => {
				await tx.insert(users).values({ name: "ada", email: "ada@example.com" });
				tx.rollback();
			})
			.catch((thrown) => thrown);
		const fine = db.transaction(async (tx) => {
			await tx.insert(users).values({ name: "bob", email: "bob@example.com" });
		});
		await Promise.all([failing, fine]);
		expect(await db.select({ name: users.name }).from(users).all()).toEqual([{ name: "bob" }]);
		await close();
	});
});

describe("drizzle over the worker client: migrations and the plain proxy", () => {
	it("migrates from bundled data, only what is pending, in one transaction", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		const first = migrate(db, { journal: { entries: bundled.journal.entries.slice(0, 1) }, migrations: bundled.migrations });
		expect(first).toBeInstanceOf(Promise);
		await first;
		expect((await db.values(sql`select name from pragma_table_info('posts')`)).map((row) => row[0])).not.toContain("published");
		await migrate(db, bundled);
		await migrate(db, bundled);
		expect((await db.values(sql`select name from pragma_table_info('posts')`)).map((row) => row[0])).toContain("published");
		expect(await db.values(sql`select count(*) from __drizzle_migrations`)).toEqual([[2]]);
		await close();
	});

	it("rolls bundled migrations back when one fails", async () => {
		const { raw, close } = await open();
		const db = drizzle(raw, { schema });
		const broken = { journal: bundled.journal, migrations: { ...bundled.migrations, m0001: "alter table nope add column x;" } };
		await expect(migrate(db, broken)).rejects.toThrow();
		expect(await db.values(sql`select count(*) from sqlite_schema where name in ('users', 'posts')`)).toEqual([[0]]);
		await close();
	});

	it("works with Drizzle's own sqlite-proxy driver on db.proxy", async () => {
		const { raw, close } = await open();
		const db = proxied(raw.proxy, { schema });
		await through(db, (queries) => raw.transaction((tx) => queries.forEach((query) => tx.execute(query))), { migrationsFolder: folder });
		const [row] = await db
			.insert(users)
			.values({ name: "ada", email: "ada@example.com", settings: { a: 1 } })
			.returning();
		expect(row).toMatchObject({ id: 1, name: "ada", settings: { a: 1 } });
		expect(await db.select().from(users).where(eq(users.id, 5)).get()).toBeUndefined();
		await close();
	});

	it("logs queries and takes a custom logger", async () => {
		const { raw, close } = await open();
		const queries = [];
		const db = drizzle(raw, { schema, logger: { logQuery: (query) => queries.push(query) } });
		await db.all(sql`select 1 as one`);
		expect(queries).toEqual(["select 1 as one"]);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await drizzle(raw, { logger: true }).all(sql`select 2`);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("select 2"));
		log.mockClear();
		await drizzle(raw, { logger: false }).all(sql`select 3`);
		expect(log).not.toHaveBeenCalled();
		await close();
	});
});
