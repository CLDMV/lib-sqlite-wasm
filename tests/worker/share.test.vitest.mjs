/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/worker/share.test.vitest.mjs
 *	@Date: 2026-11-25T05:14:19-08:00 (1795612459)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:21:03-08:00 (1795634463)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Sharing one database between tabs (`connect(..., { share: true })`), with fake tabs in one process: each has its own
 * Web Locks client, BroadcastChannel and Worker, and its workers run the real host with real SQLite on the in-memory
 * OPFS fake, so a handover really closes and reopens the database. `tab.kill()` is a tab going away; a worker's
 * `terminate()` or `fail()` is the leader's worker ending while its tab stays open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, error } from "../../src/worker/client.mts";
import { listen } from "../../src/worker/host.mts";
import { ambient, coordinator, reads } from "../../src/worker/share.mts";
import { loadSqliteModule } from "../../src/core/loader.mts";
import { fakedirectory, fakelocks } from "../fakes/opfs.mjs";
import { fakeorigin } from "../fakes/tabs.mjs";

const module = await loadSqliteModule();
const script = "https://app.test/db-worker.mjs";
const insert = "insert into t(v) values (?)";
let origin;
/** Whether workers get Web Locks (the host's hold then has none to take). */
let weblocks;
/** The database name; a new one per test, since the OPFS driver keeps state per name for the whole process. */
let name;
let counter = 0;

beforeEach(() => {
	name = `app-${++counter}.db`;
	const root = new fakedirectory();
	const locks = fakelocks();
	weblocks = true;
	origin = fakeorigin((port, worker) => {
		// The OPFS driver's locks stay on the OPFS fake; the sharing locks (sqlite:...) go to the worker's own client in
		// the origin, which lets go of them when the worker ends.
		const routed = { request: (name, ...rest) => (name.startsWith("sqlite:") ? worker.locks : locks).request(name, ...rest) };
		listen(port, { wasm: module, root, locks: weblocks ? routed : null });
		// A worker that dies lets go of its files; here the host closes the database, rolling back an open transaction.
		return (side) => side.postMessage({ id: 0, tx: false, calls: [{ op: "close" }] });
	});
});

afterEach(() => {
	for (const port of origin.ports.splice(0)) port.close();
	vi.unstubAllGlobals();
});

/** Connects from `tab` with sharing on. The page's globals are read synchronously, so they are only stubbed for the call. */
function open(tab, options = {}, path = name) {
	vi.stubGlobal("navigator", tab.navigator);
	vi.stubGlobal("BroadcastChannel", tab.BroadcastChannel);
	vi.stubGlobal("Worker", tab.Worker);
	try {
		return connect(script, path, { share: true, timeout: 2000, ...options });
	} finally {
		vi.unstubAllGlobals();
	}
}

/** Notices of one type that went over any channel. */
const notices = (type) => origin.posted.filter((each) => each.data.type === type).map((each) => each.data);
const values = (db) => db.prepare("select v from t order by id").pluck.all();
const count = (db) => db.prepare("select count(*) from t").pluck.get();
const create = (db) => db.execute("create table t(id integer primary key, v)");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A gate a transaction callback can wait on. */
function gate() {
	let open;
	const closed = new Promise((resolve) => (open = resolve));
	return { open, closed };
}

/** A tab speaking the BroadcastChannel protocol by hand, for cases a real follower doesn't produce on demand. */
function raw(tab, path = name) {
	const id = `raw-${tab.id}`;
	tab.locks.request(`sqlite:${path}:tab:${id}`, {}, () => new Promise(() => {}));
	const channel = new tab.BroadcastChannel(`sqlite:${path}`);
	const answers = new Map();
	channel.addEventListener("message", (event) => {
		if (event.data.type === "response" && event.data.tab === id) answers.set(event.data.response.id, event.data.response.outcomes);
	});
	return {
		id,
		channel,
		answers,
		send(to, request, write = true) {
			channel.postMessage({ type: "request", to, tab: id, write, request });
		}
	};
}

describe("sharing", () => {
	it("elects one leader; followers read and write through it", async () => {
		const A = origin.tab();
		const B = origin.tab();
		const a = await open(A);
		const b = await open(B);
		expect(a.info.leader).toBe(true);
		expect(b.info.leader).toBe(false);
		expect(b.info).toMatchObject({ path: a.info.path, storage: "opfs", lock: "web", open: true, transaction: false });
		expect(Object.keys(b.info)).toContain("leader");
		expect(A.workers).toHaveLength(1);
		expect(A.workers[0]).toMatchObject({ url: script, options: { type: "module" } });
		expect(B.workers).toHaveLength(0);

		await create(b);
		expect(await b.prepare(insert).run("b")).toEqual({ changes: 1, rowid: 1 });
		await a.prepare(insert).run("a");
		expect(await values(b)).toEqual(["b", "a"]);
		expect(await values(a)).toEqual(["b", "a"]);
		expect(await b.proxy("select v from t order by id", [], "all")).toEqual({ rows: [["b"], ["a"]] });
		const failure = await b
			.prepare("insert into t(id, v) values (1, 'again')")
			.run()
			.catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(error);
		expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" });

		// Only the follower's writes are announced as started: create, insert and the failed insert.
		expect(notices("started")).toHaveLength(3);
		await b.close();
		await a.close();
	});

	it("runs a follower's transaction alone, savepoints included, while other tabs wait", async () => {
		const a = await open(origin.tab());
		const b = await open(origin.tab());
		await create(a);
		let other;
		const result = await b.transaction(async (tx) => {
			await tx.prepare(insert).run("b1");
			other = a.prepare(insert).run("a1");
			await b.transaction(async (inner) => {
				await inner.prepare(insert).run("b2");
			});
			await b.transaction
				.immediate(async (inner) => {
					await inner.prepare(insert).run("undone");
					throw new Error("undo");
				})
				.catch(() => {});
			await tx.prepare(insert).run("b3");
			return "done";
		});
		expect(result).toBe("done");
		await other;
		expect(await values(b)).toEqual(["b1", "b2", "b3", "a1"]);

		// The leader's own transaction holds followers back the same way.
		let follower;
		await a.transaction(async (tx) => {
			await tx.prepare(insert).run("a2");
			follower = b.prepare(insert).run("b4");
			await tick();
			await tx.prepare(insert).run("a3");
		});
		await follower;
		expect((await values(a)).slice(-3)).toEqual(["a2", "a3", "b4"]);

		// A callback that doesn't await mid-way travels as one request.
		const before = notices("request").length;
		await b.transaction((tx) => {
			const statement = tx.prepare(insert);
			statement.run("c1");
			statement.run("c2");
		});
		expect(notices("request").length - before).toBe(1);
		expect(await count(a)).toBe(9);
	});

	it("rolls back a follower's transaction when its tab goes away mid-way", async () => {
		const a = await open(origin.tab());
		const B = origin.tab();
		const b = await open(B);
		await create(a);
		const hold = gate();
		let inserted = false;
		b.transaction(async (tx) => {
			await tx.prepare(insert).run("b");
			inserted = true;
			await hold.closed;
		}).catch(() => {});
		await vi.waitFor(() => expect(inserted).toBe(true));
		const write = a.prepare(insert).run("a");
		B.kill();
		await write;
		expect(await values(a)).toEqual(["a"]);
	});

	it("keeps a transaction whose COMMIT arrived before its tab went away", async () => {
		const a = await open(origin.tab());
		await create(a);
		const leader = notices("leader")[0].tab;
		const R = origin.tab();
		const follower = raw(R);
		follower.send(leader, {
			id: 1,
			tx: true,
			calls: [
				{ op: "begin", mode: "deferred" },
				{ op: "execute", sql: "insert into t(v) values ('r')" }
			]
		});
		await vi.waitFor(() => expect(follower.answers.has(1)).toBe(true));
		follower.send(leader, { id: 2, tx: true, calls: [{ op: "commit" }] });
		R.kill();
		expect(await values(a)).toEqual(["r"]);
	});

	it("closes with calls sent in the same message, and refuses calls after it", async () => {
		const a = await open(origin.tab());
		const b = await open(origin.tab());
		await create(a);

		const followerwrite = b.prepare(insert).run("b");
		const followerclose = b.close();
		const followerafter = b.execute("select 1");
		expect(await followerwrite).toMatchObject({ changes: 1 });
		await followerclose;
		await expect(followerafter).rejects.toMatchObject({ code: "SQLITE_MISUSE" });
		expect(b.info.open).toBe(false);

		const leaderwrite = a.prepare(insert).run("a");
		const leaderclose = a.close();
		const leaderafter = a.execute("select 1");
		expect(await leaderwrite).toMatchObject({ changes: 1 });
		await leaderclose;
		await expect(leaderafter).rejects.toMatchObject({ code: "SQLITE_MISUSE", message: "the database is closed" });
		await expect(a.execute("select 1")).rejects.toMatchObject({ code: "SQLITE_MISUSE" });

		const c = await open(origin.tab());
		expect(c.info.leader).toBe(true);
		expect(await values(c)).toEqual(["b", "a"]);
	});

	it("lets a follower close after its own calls are answered, while the leader carries on", async () => {
		const A = origin.tab();
		const a = await open(A);
		const b = await open(origin.tab());
		await create(a);
		A.workers[0].hold = true;
		const write = b.prepare(insert).run("b");
		await vi.waitFor(() => expect(A.workers[0].held).toHaveLength(1));
		let closed = false;
		const closing = b.close().then(() => (closed = true));
		await tick();
		expect(closed).toBe(false);
		A.workers[0].release();
		await write;
		await closing;
		await a.prepare(insert).run("a");
		expect(await values(a)).toEqual(["b", "a"]);
		expect(a.info.leader).toBe(true);
	});
});

describe("handover", () => {
	/** Three tabs; A leads, and B then C wait for the lock in that order. */
	async function three() {
		const tabs = [origin.tab(), origin.tab(), origin.tab()];
		const dbs = [];
		for (const tab of tabs) dbs.push(await open(tab));
		await create(dbs[0]);
		return { tabs, dbs };
	}

	it("retries requests the old leader never received, and the next tab in line takes over", async () => {
		const {
			tabs: [A],
			dbs: [, b, c]
		} = await three();
		const seen = [];
		const stopped = [];
		b.info.watch((leader) => seen.push(leader));
		const stop = b.info.watch((leader) => stopped.push(leader));
		stop();
		A.kill();
		// Both are addressed to A, which is gone: neither was started, so both go to the new leader.
		const writes = [b.prepare(insert).run("b"), c.prepare(insert).run("c")];
		const read = c.prepare("select count(*) from t").pluck.get();
		expect((await Promise.all(writes)).map((each) => each.changes)).toEqual([1, 1]);
		expect(await read).toBe(2);
		expect(b.info.leader).toBe(true);
		expect(c.info.leader).toBe(false);
		expect(seen).toEqual([true]);
		expect(stopped).toEqual([]);
		expect(await values(c)).toEqual(["b", "c"]);
	});

	it("rejects a started write whose answer was lost as uncertain, and doesn't run it twice", async () => {
		const {
			tabs: [A],
			dbs: [, b, c]
		} = await three();
		const worker = A.workers[0];
		worker.mute = true;
		const answered = worker.answers.length;
		const write = c.prepare(insert).run("c");
		await vi.waitFor(() => expect(worker.answers.length).toBe(answered + 1));
		A.kill();
		const failure = await write.catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(error);
		expect(failure).toMatchObject({ code: "SQLITE_BUSY", number: 5 });
		expect(failure.message).toMatch(/leader changed while this request was running/);
		expect(await count(b)).toBe(1);
	});

	it("rejects a started write that never ran as uncertain, and retries an unanswered read", async () => {
		const {
			tabs: [A],
			dbs: [, b, c]
		} = await three();
		const worker = A.workers[0];
		worker.hold = true;
		const write = b.prepare(insert).run("b");
		const read = c.prepare("select count(*) from t").pluck.get();
		await vi.waitFor(() => expect(worker.held).toHaveLength(2));
		A.kill();
		await expect(write).rejects.toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(/may or may not/) });
		expect(await read).toBe(0);
		expect(await count(c)).toBe(0);
		// Only B's write was announced as started, not C's read.
		expect(notices("started")).toHaveLength(1);
	});

	it("ends a transaction begun with the old leader: what is left of it fails, and its rollback succeeds", async () => {
		const {
			tabs: [A],
			dbs: [, b, c]
		} = await three();
		const hold = gate();
		let inserted = false;
		const transaction = c.transaction(async (tx) => {
			await tx.prepare(insert).run("c1");
			inserted = true;
			await hold.closed;
			await c.transaction(async (inner) => {
				await inner.prepare(insert).run("c2");
			});
		});
		await vi.waitFor(() => expect(inserted).toBe(true));
		A.kill();
		await vi.waitFor(() => expect(b.info.leader).toBe(true));
		hold.open();
		const failure = await transaction.catch((thrown) => thrown);
		expect(failure).toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(/during this transaction: it was rolled back/) });
		expect(await count(b)).toBe(0);
		await c.prepare(insert).run("c3");
		expect(await values(b)).toEqual(["c3"]);
	});

	it("hands over cleanly when the leader closes: it finishes an open transaction, and the rest goes to the next leader", async () => {
		const {
			dbs: [a, b, c]
		} = await three();
		const hold = gate();
		let inserted = false;
		const transaction = c.transaction(async (tx) => {
			await tx.prepare(insert).run("c1");
			inserted = true;
			await hold.closed;
			await tx.prepare(insert).run("c2");
		});
		await vi.waitFor(() => expect(inserted).toBe(true));
		const closing = a.close();
		const first = b.prepare(insert).run("b1");
		await tick();
		const second = b.prepare(insert).run("b2");
		await tick();
		hold.open();
		await transaction;
		await closing;
		expect(a.info.open).toBe(false);
		await Promise.all([first, second]);
		expect(b.info.leader).toBe(true);
		expect(await values(c)).toEqual(["c1", "c2", "b1", "b2"]);
	});

	it("lets a tab that joins after a handover find the new leader", async () => {
		const {
			tabs: [A],
			dbs: [, b]
		} = await three();
		await b.prepare(insert).run("b");
		A.kill();
		await vi.waitFor(() => expect(b.info.leader).toBe(true));
		const d = await open(origin.tab());
		expect(d.info.leader).toBe(false);
		expect(await values(d)).toEqual(["b"]);
	});

	it("passes the lock on when a tab can't open the database", async () => {
		const A = origin.tab();
		await expect(open(A, { journal: "bogus" })).rejects.toThrow(/journal must be one of/);
		expect(A.workers[0].dead).toBe(true);
		const b = await open(origin.tab());
		expect(b.info.leader).toBe(true);
	});

	it("fails a new leader's pending calls when it can't open the database, and the next tab takes over", async () => {
		const A = origin.tab();
		const a = await open(A);
		// B's own settings only matter once it leads.
		const b = await open(origin.tab(), { journal: "bogus" });
		const c = await open(origin.tab());
		await create(a);
		A.kill();
		const pending = b.prepare(insert).run("b");
		await expect(pending).rejects.toThrow(/journal must be one of/);
		expect(b.info.open).toBe(false);
		await vi.waitFor(() => expect(c.info.leader).toBe(true));
		await c.prepare(insert).run("c");
		expect(await values(c)).toEqual(["c"]);
	});

	it("closes the database again when the tab closed while its worker was opening it", async () => {
		const {
			tabs: [A, B],
			dbs: [, b, c]
		} = await three();
		origin.hold = true;
		A.kill();
		await vi.waitFor(() => expect(B.workers).toHaveLength(1));
		origin.hold = false;
		await b.close();
		B.workers[0].release();
		await vi.waitFor(() => expect(B.workers[0].dead).toBe(true));
		await vi.waitFor(() => expect(c.info.leader).toBe(true));
		expect(await count(c)).toBe(0);
	});
});

describe("the leader's worker ending", () => {
	/** Three tabs; A leads, and B then C wait for the lock in that order. */
	async function three() {
		const tabs = [origin.tab(), origin.tab(), origin.tab()];
		const dbs = [];
		for (const tab of tabs) dbs.push(await open(tab));
		await create(dbs[0]);
		return { tabs, dbs };
	}

	it("hands over: started writes are uncertain, reads are retried, and the tab carries on as a follower", async () => {
		const {
			tabs: [A],
			dbs: [a, b, c]
		} = await three();
		const seen = [];
		a.info.watch((leader) => seen.push(leader));
		const worker = A.workers[0];
		worker.hold = true;
		// One call per tick, so each travels as its own request: a write and a read from the leader's own tab and from C.
		const calls = [() => a.prepare(insert).run("a"), () => count(a), () => c.prepare(insert).run("c"), () => count(c)];
		const sent = [];
		for (const call of calls) {
			sent.push(call());
			await tick();
		}
		const [writes, lookups] = [
			[sent[0], sent[2]],
			[sent[1], sent[3]]
		];
		await vi.waitFor(() => expect(worker.held).toHaveLength(4));
		worker.terminate();
		for (const write of writes) {
			const failure = await write.catch((thrown) => thrown);
			expect(failure).toBeInstanceOf(error);
			expect(failure).toMatchObject({
				code: "SQLITE_BUSY",
				message: expect.stringMatching(/leader changed while this request was running/)
			});
		}
		expect(await Promise.all(lookups)).toEqual([0, 0]);
		expect(b.info.leader).toBe(true);
		expect(a.info.leader).toBe(false);
		expect(seen).toEqual([false]);
		expect(a.info.open).toBe(true);
		expect(A.workers).toHaveLength(1);

		await a.prepare(insert).run("after");
		expect(await values(c)).toEqual(["after"]);
		// A queued behind C again, so C leads next.
		await b.close();
		await vi.waitFor(() => expect(c.info.leader).toBe(true));
		await a.prepare(insert).run("again");
		expect(await values(a)).toEqual(["after", "again"]);
		expect(a.info.leader).toBe(false);
	});

	it("ends the transaction its own tab had open: the rest fails, its rollback succeeds", async () => {
		const {
			tabs: [A],
			dbs: [a, b]
		} = await three();
		await a.prepare(insert).run("kept");
		const hold = gate();
		let inserted = false;
		const transaction = a.transaction(async (tx) => {
			await tx.prepare(insert).run("a1");
			inserted = true;
			await hold.closed;
			await tx.prepare(insert).run("a2");
		});
		await vi.waitFor(() => expect(inserted).toBe(true));
		A.workers[0].terminate();
		await vi.waitFor(() => expect(b.info.leader).toBe(true));
		hold.open();
		await expect(transaction).rejects.toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(/it was rolled back/) });
		expect(await values(a)).toEqual(["kept"]);
	});

	it("leads again with a new worker when it is the only tab", async () => {
		const A = origin.tab();
		const a = await open(A);
		await create(a);
		await a.prepare(insert).run("before");
		const seen = [];
		a.info.watch((leader) => seen.push(leader));
		A.workers[0].hold = true;
		const read = values(a);
		await vi.waitFor(() => expect(A.workers[0].held).toHaveLength(1));
		A.workers[0].terminate();
		expect(await read).toEqual(["before"]);
		expect(seen).toEqual([false, true]);
		expect(A.workers).toHaveLength(2);
		expect(a.info.leader).toBe(true);
		await a.prepare(insert).run("after");
		expect(await values(a)).toEqual(["before", "after"]);
		// A tab that joins now finds it under its new id.
		const b = await open(origin.tab());
		expect(b.info.leader).toBe(false);
		expect(await count(b)).toBe(2);
	});

	it("treats an uncaught error in its worker as the worker ending, with or without Web Locks in the worker", async () => {
		for (const locked of [true, false]) {
			weblocks = locked;
			name = `app-${++counter}.db`;
			const A = origin.tab();
			const a = await open(A);
			const b = await open(origin.tab());
			await create(a);
			A.workers[0].fail("boom");
			expect(A.workers[0].dead).toBe(true);
			await vi.waitFor(() => expect(b.info.leader).toBe(true));
			await a.prepare(insert).run("a");
			expect(await values(b)).toEqual(["a"]);
			// A second error from the retired worker changes nothing.
			A.workers[0].fail("late");
			expect(b.info.leader).toBe(true);
			await b.close();
			await a.close();
		}
	});

	it("fails the open when the worker ends before the database is open, and the next tab leads", async () => {
		origin.hold = true;
		// Before the worker has taken its lock: only its error event tells.
		const A = origin.tab();
		const first = open(A);
		await vi.waitFor(() => expect(A.workers).toHaveLength(1));
		A.workers[0].fail();
		await expect(first).rejects.toMatchObject({
			code: "SQLITE_CANTOPEN",
			message: expect.stringMatching(/ended before the database was open/)
		});

		// After it took the lock: the lock tells.
		const B = origin.tab();
		const second = open(B);
		await vi.waitFor(() => expect(B.workers).toHaveLength(1));
		const worker = B.workers[0];
		await vi.waitFor(() => expect(worker.held).toHaveLength(2));
		worker.port.postMessage(worker.held.shift());
		await vi.waitFor(() => expect(worker.answers).toHaveLength(1));
		await tick();
		worker.terminate();
		await expect(second).rejects.toMatchObject({ code: "SQLITE_CANTOPEN" });

		origin.hold = false;
		const c = await open(origin.tab());
		expect(c.info.leader).toBe(true);
	});

	it("finishes its close when the worker ends during it", async () => {
		const A = origin.tab();
		const a = await open(A);
		const b = await open(origin.tab());
		await create(a);
		A.workers[0].hold = true;
		const closing = a.close();
		await vi.waitFor(() => expect(A.workers[0].held).toHaveLength(1));
		A.workers[0].terminate();
		await closing;
		expect(a.info.open).toBe(false);
		await vi.waitFor(() => expect(b.info.leader).toBe(true));
		expect(await count(b)).toBe(0);
	});

	it("finishes a close that waited behind a follower's transaction when the worker ends", async () => {
		const {
			tabs: [A],
			dbs: [a, b, c]
		} = await three();
		const hold = gate();
		let inserted = false;
		const transaction = c.transaction(async (tx) => {
			await tx.prepare(insert).run("c1");
			inserted = true;
			await hold.closed;
			await tx.prepare(insert).run("c2");
		});
		await vi.waitFor(() => expect(inserted).toBe(true));
		const closing = a.close();
		await tick();
		A.workers[0].terminate();
		await closing;
		expect(a.info.open).toBe(false);
		await vi.waitFor(() => expect(b.info.leader).toBe(true));
		hold.open();
		await expect(transaction).rejects.toMatchObject({ code: "SQLITE_BUSY" });
		expect(await count(b)).toBe(0);
	});
});

describe("the leader's protocol", () => {
	it("ignores requests for other tabs, and announcements while it leads", async () => {
		const a = await open(origin.tab());
		await create(a);
		const leader = notices("leader")[0].tab;
		const follower = raw(origin.tab());
		follower.send("someone-else", { id: 1, tx: false, calls: [{ op: "execute", sql: "insert into t(v) values ('lost')" }] });
		follower.channel.postMessage({ type: "leader", tab: follower.id, info: { path: "/x", storage: "opfs", lock: "web" } });
		follower.send(
			leader,
			{ id: 2, tx: false, calls: [{ op: "statement", sql: "select count(*) from t", params: [], shape: "pluck", first: true }] },
			false
		);
		await vi.waitFor(() => expect(follower.answers.has(2)).toBe(true));
		expect(follower.answers.get(2)).toEqual([{ ok: true, value: 0 }]);
		expect(follower.answers.has(1)).toBe(false);
		expect(a.info.leader).toBe(true);
		expect(notices("started")).toHaveLength(0);
	});

	it("stops taking requests once its close comes up", async () => {
		const A = origin.tab();
		const a = await open(A);
		await create(a);
		const leader = notices("leader")[0].tab;
		const follower = raw(origin.tab());
		A.workers[0].hold = true;
		const closing = a.close();
		await vi.waitFor(() => expect(A.workers[0].held).toHaveLength(1));
		const announced = notices("leader").length;
		follower.channel.postMessage({ type: "hello", tab: follower.id });
		follower.send(leader, { id: 1, tx: false, calls: [{ op: "execute", sql: "insert into t(v) values ('late')" }] });
		await tick();
		A.workers[0].release();
		await closing;
		expect(notices("leader")).toHaveLength(announced);
		expect(follower.answers.size).toBe(0);
		const b = await open(origin.tab());
		expect(await count(b)).toBe(0);
	});

	it("answers calls made after it stopped with a closed error", async () => {
		const T = origin.tab();
		const env = { locks: T.locks, channel: (name) => new T.BroadcastChannel(name), spawn: () => new T.Worker(script), id: () => "solo" };
		const shared = new coordinator(script, env);
		const answers = [];
		const errors = [];
		const listener = (event) => answers.push(event.data);
		shared.addEventListener("message", listener);
		shared.addEventListener("error", (event) => errors.push(event));
		shared.postMessage({ id: 1, tx: false, calls: [{ op: "open", path: "solo.db", options: {} }] });
		await vi.waitFor(() => expect(answers).toHaveLength(1));
		expect(answers[0].outcomes[0]).toMatchObject({ ok: true, value: { storage: "opfs" } });
		expect(shared.leader).toBe(true);
		shared.postMessage({ id: 2, tx: false, calls: [{ op: "close" }] });
		await vi.waitFor(() => expect(answers).toHaveLength(2));
		shared.postMessage({ id: 3, tx: false, calls: [{ op: "execute", sql: "select 1" }] });
		expect(answers[2]).toEqual({ id: 3, outcomes: [{ ok: false, error: expect.objectContaining({ code: "SQLITE_MISUSE" }) }] });
		shared.removeEventListener("message", listener);
		shared.postMessage({ id: 4, tx: false, calls: [{ op: "execute", sql: "select 1" }] });
		expect(answers).toHaveLength(3);
		expect(errors).toEqual([]);
	});
});

describe("setup", () => {
	it("needs the worker's URL and a browser page", async () => {
		const T = origin.tab();
		const { port1 } = new MessageChannel();
		origin.ports.push(port1);
		vi.stubGlobal("navigator", T.navigator);
		vi.stubGlobal("BroadcastChannel", T.BroadcastChannel);
		vi.stubGlobal("Worker", T.Worker);
		await expect(connect(port1, "x.db", { share: true })).rejects.toThrow(/needs the worker script's URL/);
		const missing = [
			["navigator", undefined],
			["navigator", {}],
			["BroadcastChannel", undefined],
			["Worker", undefined]
		];
		for (const [name, value] of missing) {
			vi.stubGlobal("navigator", T.navigator);
			vi.stubGlobal("BroadcastChannel", T.BroadcastChannel);
			vi.stubGlobal("Worker", T.Worker);
			vi.stubGlobal(name, value);
			expect(() => ambient(script)).toThrow(/needs Web Locks, BroadcastChannel and Worker/);
			await expect(connect(script, "x.db", { share: true })).rejects.toThrow(TypeError);
		}
	});

	it("reads the page's APIs", () => {
		const T = origin.tab();
		vi.stubGlobal("navigator", T.navigator);
		vi.stubGlobal("BroadcastChannel", T.BroadcastChannel);
		vi.stubGlobal("Worker", T.Worker);
		const env = ambient(new URL(script));
		expect(env.locks).toBe(T.locks);
		expect(env.channel("x")).toBeInstanceOf(T.BroadcastChannel);
		const worker = env.spawn();
		expect(worker).toBeInstanceOf(T.Worker);
		expect(worker.options).toEqual({ type: "module" });
		expect(env.id()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("tells reads from writes", () => {
		const statement = (sql) => ({ op: "statement", sql, params: [], shape: "object", first: false });
		expect(
			reads({
				id: 1,
				tx: false,
				calls: [statement("select 1"), statement("  VALUES (1)"), { op: "columns", sql: "select 1" }, { op: "serialize" }]
			})
		).toBe(true);
		expect(reads({ id: 1, tx: false, calls: [statement("select 1"), statement("insert into t values (1)")] })).toBe(false);
		expect(reads({ id: 1, tx: false, calls: [statement("with x as (select 1) insert into t select * from x")] })).toBe(false);
		expect(reads({ id: 1, tx: false, calls: [{ op: "execute", sql: "select 1" }] })).toBe(false);
		expect(reads({ id: 1, tx: true, calls: [statement("select 1")] })).toBe(false);
	});
});
