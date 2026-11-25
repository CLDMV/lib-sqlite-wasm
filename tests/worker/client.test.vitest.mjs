/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/worker/client.test.vitest.mjs
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
 * The client and the host end to end, over a MessageChannel instead of a worker, with the real sqlite3.wasm. OPFS
 * runs on the in-memory fake, so the OPFS driver is exercised against real SQLite I/O.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import client, { connect, err, error } from "../../src/worker/client.mts";
import { listen } from "../../src/worker/host.mts";
import { loadSqliteModule } from "../../src/core/loader.mts";
import { fakedirectory, fakelocks } from "../fakes/opfs.mjs";

const module = await loadSqliteModule();
const ports = [];

/** A client-side port connected to a fresh host. */
function channel(options = {}) {
	const { port1, port2 } = new MessageChannel();
	ports.push(port1, port2);
	listen(port2, { wasm: module, ...options });
	return port1;
}

const memory = (name = "mem.db", options = {}) => connect(channel(), name, { storage: "memory", ...options });

afterEach(() => {
	for (const port of ports.splice(0)) port.close();
	vi.unstubAllGlobals();
});

describe("client surface", () => {
	it("keeps aliases as the same functions", async () => {
		const db = await memory();
		const statement = db.prepare("select 1 as one");
		expect(client.connect).toBe(connect);
		expect(client.error).toBe(error);
		expect(client.err).toBe(error);
		expect(err).toBe(error);
		expect(db.prep).toBe(db.prepare);
		expect(db.exec).toBe(db.execute);
		expect(db.tx).toBe(db.transaction);
		expect(db.ckpt).toBe(db.checkpoint);
		expect(statement.iter).toBe(statement.iterate);
		expect(statement.cols).toBe(statement.columns);
		expect(statement.raw.iter).toBe(statement.raw.iterate);
		await db.close();
	});

	it("runs statements in every shape", async () => {
		const db = await memory();
		expect(db.info).toMatchObject({ path: "mem.db", storage: "memory", open: true, transaction: false });
		await db.exec("create table t(id integer primary key, a, b)");
		const insert = db.prep("insert into t(a, b) values (?, ?)");
		expect(await insert.run("x", 1)).toEqual({ changes: 1, rowid: 1 });
		expect(await insert.run(["y", 2])).toEqual({ changes: 1, rowid: 2 });
		expect(await db.prepare("insert into t(a, b) values (:a, :b)").run({ a: "z", b: 3 })).toEqual({ changes: 1, rowid: 3 });

		const select = db.prepare("select a, b from t order by id");
		expect(select.info.sql).toBe("select a, b from t order by id");
		expect(await select.get()).toEqual({ a: "x", b: 1 });
		expect(await select.all()).toEqual([
			{ a: "x", b: 1 },
			{ a: "y", b: 2 },
			{ a: "z", b: 3 }
		]);
		const seen = [];
		for await (const row of select.iterate()) seen.push(row.a);
		expect(seen).toEqual(["x", "y", "z"]);
		expect(await select.raw.get()).toEqual(["x", 1]);
		expect(await select.raw.all()).toHaveLength(3);
		const raw = [];
		for await (const row of select.raw.iter()) raw.push(row);
		expect(raw[2]).toEqual(["z", 3]);
		expect(await select.pluck.get()).toBe("x");
		expect(await select.pluck.all()).toEqual(["x", "y", "z"]);
		expect(await select.expand.get()).toEqual({ t: { a: "x", b: 1 } });
		expect(await select.expand.all()).toHaveLength(3);
		expect(await select.cols()).toEqual([
			{ name: "a", column: "a", table: "t", database: "main", type: null },
			{ name: "b", column: "b", table: "t", database: "main", type: null }
		]);

		expect(await db.prepare("select ? as v").pluck.get(null)).toBeNull();
		expect(await db.prepare("select ? as v").pluck.get(new Uint8Array([7]))).toEqual(new Uint8Array([7]));

		const bound = db.prepare("select b from t where a = ?").bind("y");
		expect(await bound.pluck.get()).toBe(2);
		expect(() => bound.bind("x")).toThrow(/only be called once/);
		await expect(bound.get("x")).rejects.toThrow(/already bound/);

		bound.close();
		await expect(bound.get()).rejects.toMatchObject({ code: "SQLITE_MISUSE" });
		await expect(bound.columns()).rejects.toThrow(/statement is closed/);
		await db.close();
	});

	it("rejects with SQLite errors carrying code, number and sql", async () => {
		const db = await memory();
		await db.execute("create table t(a unique)");
		await db.prepare("insert into t values (1)").run();
		const failure = await db
			.prepare("insert into t values (1)")
			.run()
			.catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(client.error);
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", number: 2067, sql: "insert into t values (1)" });
		await expect(db.prepare("select ? as a").get({})).rejects.toMatchObject({ name: "RangeError" });
		await db.close();
	});

	it("reads and writes pragmas and checkpoints", async () => {
		const db = await memory();
		expect(await db.pragma.get("foreign_keys")).toBe(1);
		await db.pragma.set("user_version", 7);
		expect(await db.pragma.get("main.user_version")).toBe(7);
		await db.pragma.set("user_version", 8n);
		await db.pragma.set("foreign_keys", false);
		await db.pragma.set("recursive_triggers", true);
		await db.pragma.set("temp_store", null).catch(() => {});
		await db.pragma.set("application_id", "12");
		await db.execute("create table t(a, b)");
		expect((await db.pragma.all("table_info", "t")).map((column) => column.name)).toEqual(["a", "b"]);
		expect((await db.pragma.all("table_list")).some((entry) => entry.name === "t")).toBe(true);
		await expect(db.pragma.get("bad name")).rejects.toThrow(/invalid PRAGMA name/);
		await expect(db.pragma.set("user_version", {})).rejects.toThrow(/PRAGMA value must be/);
		await expect(db.pragma.all("table_info", "it's")).resolves.toEqual([]);

		expect(Object.keys(await db.checkpoint())).toEqual(["busy", "log", "checkpointed"]);
		await db.ckpt("truncate");
		expect(await db.checkpoint("passive")).toEqual({ busy: 0, log: 0, checkpointed: 0 });
		await expect(db.checkpoint("bogus")).rejects.toThrow(/unknown checkpoint mode/);
		await db.close();
	});

	it("serves the drizzle sqlite-proxy callback", async () => {
		const db = await memory();
		expect(await db.proxy("create table t(a, b)", [], "run")).toEqual({ rows: [] });
		expect(await db.proxy("insert into t values (?, ?)", [1, "x"], "run")).toEqual({ rows: [] });
		expect(await db.proxy("select a, b from t", [], "get")).toEqual({ rows: [1, "x"] });
		expect(await db.proxy("select a, b from t where a = ?", [9], "get")).toEqual({ rows: null });
		expect(await db.proxy("select a, b from t", [], "all")).toEqual({ rows: [[1, "x"]] });
		expect(await db.proxy("select a, b from t", [], "values")).toEqual({ rows: [[1, "x"]] });
		await db.close();
	});

	it("rejects every call after close", async () => {
		const db = await memory();
		await db.close();
		await db.close();
		expect(db.info.open).toBe(false);
		await expect(db.execute("select 1")).rejects.toMatchObject({ code: "SQLITE_MISUSE", number: 21 });
		await expect(db.transaction(async () => {})).rejects.toThrow(/database is closed/);
	});

	it("ignores answers to requests it never sent", async () => {
		const { port1, port2 } = new MessageChannel();
		ports.push(port1, port2);
		port2.addEventListener("message", (event) => {
			port2.postMessage({ id: 999, outcomes: [] });
			port2.postMessage({ id: event.data.id, outcomes: [{ ok: true, value: { path: "x", storage: "memory" } }] });
		});
		port2.start();
		const db = await connect(port1, "x");
		expect(db.info.path).toBe("x");
	});
});

describe("transactions", () => {
	it("commits, returns the callback's value, and lets earlier statements join", async () => {
		const db = await memory();
		await db.execute("create table t(a)");
		const insert = db.prepare("insert into t values (?)");
		const result = await db.transaction(async (tx) => {
			expect(db.info.transaction).toBe(true);
			await tx.prepare("insert into t values (?)").run(1);
			await insert.run(2);
			await tx.exec("insert into t values (3)");
			expect(tx.prep).toBe(tx.prepare);
			return (await tx.pragma.get("user_version")) + 41;
		});
		expect(result).toBe(41);
		expect(db.info.transaction).toBe(false);
		expect(await db.prepare("select a from t order by a").pluck.all()).toEqual([1, 2, 3]);
		await db.close();
	});

	it("rolls back when the callback throws, including calls it never sent", async () => {
		const db = await memory();
		await db.execute("create table t(a)");
		await expect(
			db.tx(async (tx) => {
				await tx.execute("insert into t values (1)");
				throw new Error("changed my mind");
			})
		).rejects.toThrow("changed my mind");
		const unsent = [];
		await expect(
			db.transaction.immediate((tx) => {
				unsent.push(tx.execute("insert into t values (2)"));
				throw new Error("sync throw");
			})
		).rejects.toThrow("sync throw");
		await expect(unsent[0]).rejects.toThrow("sync throw");
		expect(await db.prepare("select count(*) as n from t").pluck.get()).toBe(0);
		await db.close();
	});

	it("fails the whole transaction when an unawaited statement fails", async () => {
		const db = await memory();
		await db.execute("create table t(a unique)");
		const failure = await db.transaction
			.exclusive((tx) => {
				const insert = tx.prepare("insert into t values (?)");
				insert.run(1);
				insert.run(1);
				insert.run(2);
				return "done";
			})
			.catch((thrown) => thrown);
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
		expect(await db.prepare("select count(*) from t").pluck.get()).toBe(0);
		await db.close();
	});

	it("rolls back when the commit itself fails", async () => {
		const db = await memory();
		await db.execute("create table parent(id primary key); create table child(p references parent(id) deferrable initially deferred)");
		const failure = await db.transaction
			.deferred(async (tx) => {
				await tx.execute("insert into child values (1)");
			})
			.catch((thrown) => thrown);
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
		expect(await db.prepare("select count(*) from child").pluck.get()).toBe(0);
		await db.close();
	});

	it("reports a BEGIN that fails without touching the transaction already open", async () => {
		const db = await memory();
		await db.execute("create table t(a); begin; insert into t values (1)");
		const failure = await db
			.transaction(async (tx) => {
				await tx.execute("insert into t values (2)");
			})
			.catch((thrown) => thrown);
		expect(failure.message).toMatch(/within a transaction/);
		await db.execute("commit");
		expect(await db.prepare("select a from t").pluck.all()).toEqual([1]);
		await db.close();
	});

	it("sends a callback that never awaits as one message, COMMIT included", async () => {
		const port = channel();
		const sent = [];
		const post = port.postMessage.bind(port);
		port.postMessage = (message) => {
			sent.push(message);
			post(message);
		};
		const db = await connect(port, "mem.db", { storage: "memory" });
		await db.execute("create table t(a)");
		sent.length = 0;
		await db.transaction((tx) => {
			const insert = tx.prepare("insert into t values (?)");
			insert.run(1);
			insert.run(2);
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].tx).toBe(true);
		expect(sent[0].calls.map((item) => item.op)).toEqual(["begin", "statement", "statement", "commit"]);
		await db.close();
	});

	it("runs concurrent transactions one after another", async () => {
		const db = await memory();
		await db.execute("create table t(a)");
		const order = [];
		await Promise.all([
			db.transaction(async (tx) => {
				order.push("first start");
				await tx.execute("insert into t values (1)");
				order.push("first end");
			}),
			db.transaction(async (tx) => {
				order.push("second start");
				await tx.execute("insert into t values (2)");
				order.push("second end");
			})
		]);
		expect(order).toEqual(["first start", "first end", "second start", "second end"]);
		await db.close();
	});
});

describe("batching independent calls", () => {
	it("gives each call its own result inside a shared commit", async () => {
		const db = await memory();
		await db.execute("create table t(a unique)");
		const insert = db.prepare("insert into t values (?)");
		const results = await Promise.allSettled([
			insert.run(1),
			insert.run(1),
			insert.run(2),
			db.prepare("select count(*) from t").pluck.get()
		]);
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
		expect(results[3].value).toBe(2);
		expect(await db.prepare("select a from t order by a").pluck.all()).toEqual([1, 2]);
		await db.close();
	});

	it("reports earlier writes as failed when SQLite rolls the shared transaction back, then carries on", async () => {
		const db = await memory();
		await db.execute("create table t(a unique)");
		await db.prepare("insert into t values (9)").run();
		const results = await Promise.allSettled([
			db.prepare("insert into t values (1)").run(),
			db.prepare("insert or rollback into t values (9)").run(),
			db.prepare("insert into t values (2)").run()
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
		expect(await db.prepare("select a from t order by a").pluck.all()).toEqual([2, 9]);
		await db.close();
	});

	it("reports the writes as failed when the shared commit fails", async () => {
		const db = await memory();
		await db.execute("create table parent(id primary key); create table child(p references parent(id) deferrable initially deferred)");
		const results = await Promise.allSettled([
			db.prepare("insert into child values (1)").run(),
			db.prepare("select count(*) from child").pluck.get(),
			db.prepare("insert into child values (2)").run()
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "rejected"]);
		expect(results[0].reason).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
		expect(await db.prepare("select count(*) from child").pluck.get()).toBe(0);
		await db.close();
	});

	it("runs calls one by one inside a transaction the caller opened", async () => {
		const db = await memory();
		await db.execute("create table t(a); begin");
		const insert = db.prepare("insert into t values (?)");
		await Promise.all([insert.run(1), insert.run(2), db.execute("commit")]);
		expect(await db.prepare("select count(*) from t").pluck.get()).toBe(2);
		await db.close();
	});
});

describe("OPFS storage", () => {
	const opfs = () => {
		const root = new fakedirectory();
		const locks = fakelocks();
		return { root, locks, open: (path, options = {}) => connect(channel({ root, locks }), path, options) };
	};

	for (const journal of ["wal", "truncate", "delete"]) {
		it(`creates, writes, closes and reopens a database in ${journal} mode`, async () => {
			const store = opfs();
			const db = await store.open("data/app.db", { journal });
			expect(db.info).toMatchObject({ path: "/data/app.db", storage: "opfs" });
			expect(await db.pragma.get("journal_mode")).toBe(journal);
			await db.execute("create table t(a)");
			await db.transaction(async (tx) => {
				const insert = tx.prepare("insert into t values (?)");
				for (let index = 0; index < 100; index++) insert.run(index);
			});
			await db.close();
			const folder = await store.root.getDirectoryHandle("data");
			expect(folder.names()).toEqual(["app.db"]);
			expect(store.locks.held.size).toBe(0);

			const again = await store.open("data/app.db", { journal });
			expect(await again.prepare("select count(*) from t").pluck.get()).toBe(100);
			expect(await again.prepare("pragma integrity_check").pluck.get()).toBe("ok");
			await again.close();
		});
	}

	it("opens read-only", async () => {
		const store = opfs();
		const db = await store.open("app.db", { journal: "delete" });
		await db.execute("create table t(a); insert into t values (1)");
		await db.close();
		const readonly = await store.open("app.db", { readonly: true });
		expect(await readonly.prepare("select a from t").pluck.get()).toBe(1);
		await expect(readonly.execute("insert into t values (2)")).rejects.toMatchObject({ code: "SQLITE_READONLY" });
		await readonly.close();
	});

	it("refuses a database another tab has open", async () => {
		const store = opfs();
		const db = await store.open("app.db");
		const failure = await store.open("app.db").catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(error);
		expect(failure).toMatchObject({ code: "SQLITE_BUSY", number: 5 });
		expect(failure.message).toMatch(/open in another tab/);
		await db.close();
	});

	it("releases the lock when opening fails", async () => {
		const store = opfs();
		await expect(store.open("missing.db", { create: false })).rejects.toMatchObject({ code: "SQLITE_CANTOPEN" });
		expect(store.locks.held.size).toBe(0);
		const db = await store.open("missing.db");
		await db.close();
	});

	it("attaches and detaches other OPFS databases", async () => {
		const store = opfs();
		const db = await store.open("main.db");
		await db.attach("other.db", "other");
		await db.execute("create table other.t(a); insert into other.t values (1)");
		await expect(db.attach("third.db", "other")).rejects.toThrow(/already in use/);
		expect(store.locks.held.has("sqlite-wasm:/third.db")).toBe(false);
		await db.detach("other");
		expect(store.locks.held.has("sqlite-wasm:/other.db")).toBe(false);
		await db.attach("other.db", "again");
		expect(await db.prepare("select a from again.t").pluck.get()).toBe(1);
		await db.close();
		expect(store.locks.held.size).toBe(0);
	});

	it("attaches in-memory databases with memory storage", async () => {
		const db = await memory();
		await db.attach("side.db", "side");
		await db.execute("create table side.t(a)");
		await expect(db.attach("other.db", "side")).rejects.toThrow(/already in use/);
		await db.detach("side");
		await db.close();
	});
});

describe("worker targets", () => {
	/** A Worker stand-in that runs the host on the other end of a MessageChannel. */
	class fakeworker {
		static last;
		constructor(url, options) {
			const { port1, port2 } = new MessageChannel();
			ports.push(port1, port2);
			listen(port2, { wasm: module });
			this.url = url;
			this.options = options;
			this.port = port1;
			this.errors = [];
			this.terminated = false;
			fakeworker.last = this;
		}
		postMessage(message) {
			this.port.postMessage(message);
		}
		addEventListener(type, listener) {
			if (type === "message") this.port.addEventListener(type, listener);
			else this.errors.push(listener);
		}
		removeEventListener(type, listener) {
			this.port.removeEventListener(type, listener);
		}
		start() {
			this.port.start();
		}
		terminate() {
			this.terminated = true;
		}
	}

	it("starts a module worker from a URL and terminates it on close", async () => {
		vi.stubGlobal("Worker", fakeworker);
		const db = await connect("https://app.test/db-worker.mjs", "mem.db", { storage: "memory" });
		const worker = fakeworker.last;
		expect(worker.url).toBe("https://app.test/db-worker.mjs");
		expect(worker.options).toEqual({ type: "module" });
		await db.close();
		expect(worker.terminated).toBe(true);
	});

	it("terminates the worker when opening fails", async () => {
		vi.stubGlobal("Worker", fakeworker);
		await expect(connect(new URL("https://app.test/w.mjs"), "mem.db", { storage: "memory", journal: "bogus" })).rejects.toThrow(
			/unknown journal mode/
		);
		expect(fakeworker.last.terminated).toBe(true);
	});

	it("rejects pending calls when the worker fails", async () => {
		vi.stubGlobal("Worker", fakeworker);
		const db = await connect("https://app.test/w.mjs", "mem.db", { storage: "memory" });
		const worker = fakeworker.last;
		const pending = db.execute("select 1");
		worker.errors[0]({ message: "script error" });
		await expect(pending).rejects.toThrow("the worker failed: script error");
		worker.errors[0]({});
		await expect(db.execute("select 1")).rejects.toMatchObject({ code: "SQLITE_MISUSE" });
		expect(worker.terminated).toBe(true);
	});

	it("reports a worker failure without a message", async () => {
		vi.stubGlobal("Worker", fakeworker);
		const db = await connect("https://app.test/w.mjs", "mem.db", { storage: "memory" });
		const pending = db.execute("select 1");
		// Let the call go out first, so it is waiting on an answer rather than still queued.
		await Promise.resolve();
		fakeworker.last.errors[0]({});
		await expect(pending).rejects.toThrow(/^sqlite-wasm: the worker failed$/);
	});
});
