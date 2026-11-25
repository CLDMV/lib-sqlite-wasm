/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/worker/host.test.vitest.mjs
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
 * The host's protocol handling, driven with raw messages. Most paths run against a scripted fake connection, so
 * failures SQLite rarely produces (a BEGIN or COMMIT that throws) can be reproduced exactly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import host, { listen, serve } from "../../src/worker/host.mts";

const ports = [];

afterEach(() => {
	for (const port of ports.splice(0)) port.close();
	vi.unstubAllGlobals();
});

/** A connection whose transaction state follows BEGIN / COMMIT / ROLLBACK, with hooks to make calls fail. */
function fakeengine(hooks = {}) {
	const state = { auto: true, log: [] };
	const db = {
		info: { path: "x.db", storage: "memory", lock: "none" },
		attach: async (path, schema) => state.log.push(`attach ${path} ${schema}`),
		detach: async (schema) => state.log.push(`detach ${schema}`),
		backup: async (target, options) => state.log.push(`backup ${target} ${JSON.stringify(options)}`),
		serialize: (schema) => (state.log.push(`serialize ${schema}`), new Uint8Array([1, 2, 3]))
	};
	return Object.assign(state, {
		db,
		execute(sql) {
			state.log.push(sql);
			hooks.execute?.(sql, state);
			if (/^BEGIN/.test(sql)) state.auto = false;
			if (/^(COMMIT|ROLLBACK)$/.test(sql)) state.auto = true;
		},
		statement(sql, params, shape) {
			state.log.push(sql);
			hooks.statement?.(sql, state);
			return shape === "run" ? { changes: 1, rowid: 1 } : [];
		},
		columns: () => [],
		autocommit: () => state.auto,
		close: () => state.log.push("close")
	});
}

/** A host on a MessageChannel with the given dependencies; returns a request function. */
function start(dependencies) {
	const { port1, port2 } = new MessageChannel();
	ports.push(port1, port2);
	const stop = serve(port2, dependencies);
	let next = 1;
	const waiting = new Map();
	port1.addEventListener("message", (event) => {
		waiting.get(event.data.id)(event.data.outcomes);
		waiting.delete(event.data.id);
	});
	port1.start();
	/** Posts one request and resolves to its outcomes. */
	const send = (calls, tx = false) => {
		const id = next++;
		port1.postMessage({ id, tx, calls });
		return new Promise((resolve) => waiting.set(id, resolve));
	};
	return { send, stop, port: port1 };
}

const open = { op: "open", path: "x.db", options: { storage: "memory" } };
const insert = (value = 1) => ({ op: "statement", sql: "INSERT INTO t VALUES (?)", params: [value], shape: "run", first: false });
const statuses = (outcomes) => outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.error.message));

describe("host", () => {
	it("exposes listen on the namespace", () => {
		expect(host.listen).toBe(listen);
	});

	it("answers calls before open with a misuse error, and unknown operations with an error", async () => {
		const { send } = start({ connect: async () => fakeengine() });
		const [before] = await send([{ op: "execute", sql: "select 1" }]);
		expect(before.error).toMatchObject({ code: "SQLITE_MISUSE", number: 21, sql: "select 1" });
		expect(statuses(await send([{ op: "bogus" }]))).toEqual(['unknown operation "bogus"']);
		expect(statuses(await send([insert(), insert()]))).toEqual(["no database is open", "no database is open"]);
		expect(statuses(await send([insert()], true))).toEqual(["no database is open"]);
		expect(statuses(await send([{ op: "commit" }], true))).toEqual(["no database is open"]);
		// Closing with nothing open is a no-op.
		expect(statuses(await send([{ op: "close" }]))).toEqual(["ok"]);
	});

	it("refuses a second open, runs the setup hook, and closes the connection when setup fails", async () => {
		const engine = fakeengine();
		const seen = [];
		let fail = false;
		const { send } = start({
			connect: async () => engine,
			setup(db) {
				seen.push(db);
				if (fail) throw new RangeError("setup broke");
			}
		});
		const [opened, second] = await send([open, open]);
		expect(opened.value).toEqual({ path: "x.db", storage: "memory", lock: "none" });
		expect(second.error.message).toBe("a database is already open in this worker");
		expect(seen).toEqual([engine.db]);
		await send([{ op: "close" }]);
		fail = true;
		const [failed] = await send([open]);
		expect(failed.error).toMatchObject({ name: "RangeError", message: "setup broke" });
		expect(engine.log.filter((entry) => entry === "close")).toHaveLength(2);
		// The failed open left nothing open.
		expect(statuses(await send([insert()]))).toEqual(["no database is open"]);
	});

	it("reports a connection that can't be made", async () => {
		const { send } = start({
			connect: async () => {
				throw Object.assign(new Error("unable to open database file"), { number: 14 });
			}
		});
		const [failed] = await send([open]);
		expect(failed.error).toMatchObject({ name: "sqlite.error", code: "SQLITE_CANTOPEN", number: 14 });
	});

	it("passes attach, detach, backup and serialize to the database, transferring the serialized bytes", async () => {
		const engine = fakeengine();
		const { send } = start({ connect: async () => engine });
		await send([open]);
		const outcomes = await send([
			{ op: "attach", path: "other.db", schema: "other" },
			{ op: "detach", schema: "other" },
			{ op: "backup", target: "copy.db" },
			{ op: "backup", target: "copy.db", schema: "other" },
			{ op: "serialize" },
			{ op: "serialize", schema: "other" }
		]);
		expect(statuses(outcomes)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
		expect(outcomes[4].value).toEqual(new Uint8Array([1, 2, 3]));
		expect(engine.log).toEqual([
			"attach other.db other",
			"detach other",
			"backup copy.db {}",
			'backup copy.db {"schema":"other"}',
			"serialize undefined",
			"serialize other"
		]);
	});

	it("posts serialized bytes with their buffer in the transfer list", async () => {
		const posted = [];
		const scope = {
			addEventListener: (type, listener) => (scope.listener = listener),
			removeEventListener() {},
			postMessage: (message, transfer) => posted.push({ message, transfer })
		};
		serve(scope, { connect: async () => fakeengine() });
		scope.listener({ data: { id: 1, tx: false, calls: [open, { op: "serialize" }] } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const [{ message, transfer }] = posted;
		expect(transfer).toEqual([message.outcomes[1].value.buffer]);
	});

	it("merges requests that queue up while it is busy", async () => {
		const engine = fakeengine();
		// Opening takes a while, so the next requests arrive while the host is busy.
		const { send } = start({ connect: () => new Promise((resolve) => setTimeout(() => resolve(engine), 30)) });
		const results = await Promise.all([
			send([open]),
			send([insert(1)]),
			send([insert(2)]),
			send([{ op: "begin", mode: "deferred" }, { op: "commit" }], true)
		]);
		expect(results.map(statuses)).toEqual([["ok"], ["ok"], ["ok"], ["ok", "ok"]]);
		// The two single-statement requests ran inside one transaction; the transaction request ran on its own.
		expect(engine.log.filter((sql) => !sql.startsWith("PRAGMA"))).toEqual([
			"BEGIN",
			"INSERT INTO t VALUES (?)",
			"INSERT INTO t VALUES (?)",
			"COMMIT",
			"BEGIN DEFERRED",
			"COMMIT"
		]);
	});

	it("fails the whole batch when BEGIN itself fails", async () => {
		const engine = fakeengine({
			execute(sql) {
				if (sql === "BEGIN") throw new Error("begin broke");
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		expect(statuses(await send([insert(1), insert(2)]))).toEqual(["begin broke", "begin broke"]);
	});

	it("does not roll back a shared commit that failed and already ended the transaction", async () => {
		const engine = fakeengine({
			execute(sql, state) {
				if (sql === "COMMIT") {
					state.auto = true;
					throw Object.assign(new Error("disk full"), { number: 13 });
				}
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		const outcomes = await send([insert(1), { op: "statement", sql: "SELECT 1", params: [], shape: "raw", first: true }]);
		expect(statuses(outcomes)).toEqual(["disk full", "ok"]);
		expect(outcomes[0].error.code).toBe("SQLITE_FULL");
		expect(engine.log).not.toContain("ROLLBACK");
	});

	it("skips COMMIT when SQLite rolled the shared transaction back on the last statement", async () => {
		const engine = fakeengine({
			statement(sql, state) {
				if (sql.includes("rollback")) {
					state.auto = true;
					throw Object.assign(new Error("constraint"), { number: 19 });
				}
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		const last = { op: "statement", sql: "INSERT OR rollback INTO t VALUES (1)", params: [], shape: "run", first: false };
		expect(statuses(await send([insert(), last]))).toEqual(["constraint", "constraint"]);
		expect(engine.log.filter((sql) => !sql.startsWith("PRAGMA"))).not.toContain("COMMIT");
	});

	it("handles transaction batches: skips after a failure, resets on commit or rollback", async () => {
		const engine = fakeengine({
			statement(sql) {
				if (sql.includes("fail")) throw Object.assign(new Error("constraint"), { number: 19 });
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		const failing = { op: "statement", sql: "INSERT fail", params: [], shape: "run", first: false };
		expect(statuses(await send([{ op: "begin", mode: "immediate" }, insert(), failing, insert()], true))).toEqual([
			"ok",
			"ok",
			"constraint",
			"constraint"
		]);
		expect(engine.log).toContain("BEGIN IMMEDIATE");
		expect(engine.log.at(-1)).toBe("ROLLBACK");
		// The client sends more before it learns of the failure: those are refused, COMMIT fails and ends it.
		expect(statuses(await send([insert(), { op: "commit" }], true))).toEqual(["constraint", "constraint"]);
		// A fresh transaction works again; an unknown mode is a plain BEGIN; ROLLBACK on an open transaction runs.
		expect(statuses(await send([{ op: "begin", mode: "whatever" }, insert(), { op: "rollback" }], true))).toEqual(["ok", "ok", "ok"]);
		expect(engine.log.slice(-3)).toEqual(["BEGIN", "INSERT INTO t VALUES (?)", "ROLLBACK"]);
		// A failure with the transaction already gone needs no ROLLBACK.
		engine.log.length = 0;
		expect(statuses(await send([failing, { op: "rollback" }], true))).toEqual(["constraint", "ok"]);
		expect(engine.log).toEqual(["INSERT fail"]);
	});

	it("ends the transaction when COMMIT fails", async () => {
		const engine = fakeengine({
			execute(sql, state) {
				if (sql === "COMMIT") {
					if (state.keep) throw new Error("busy");
					state.auto = true;
					throw new Error("gone");
				}
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		expect(statuses(await send([{ op: "begin", mode: "deferred" }, insert(), { op: "commit" }], true))).toEqual(["ok", "ok", "gone"]);
		expect(engine.log).not.toContain("ROLLBACK");
		engine.keep = true;
		expect(statuses(await send([{ op: "begin", mode: "deferred" }, { op: "commit" }], true))).toEqual(["ok", "busy"]);
		expect(engine.log.at(-1)).toBe("ROLLBACK");
		engine.keep = false;
		expect(statuses(await send([{ op: "begin", mode: "deferred" }, { op: "commit" }], true))).toEqual(["ok", "gone"]);
	});

	it("undoes only a failed savepoint, and goes on with the transaction around it", async () => {
		const engine = fakeengine({
			statement(sql) {
				if (sql.includes("fail")) throw Object.assign(new Error("constraint"), { number: 19 });
			}
		});
		const { send } = start({ connect: async () => engine });
		await send([open]);
		const failing = { op: "statement", sql: "INSERT fail", params: [], shape: "run", first: false };
		const begin = { op: "begin", mode: "deferred" };
		const savepoint = (name) => ({ op: "savepoint", name });
		const release = (name) => ({ op: "release", name });
		const revert = (name) => ({ op: "revert", name });

		// A failure inside a savepoint: the rest of it is skipped, revert undoes it, the outer transaction commits.
		expect(
			statuses(await send([begin, savepoint("a"), insert(), failing, insert(), revert("a"), insert(), { op: "commit" }], true))
		).toEqual(["ok", "ok", "ok", "constraint", "constraint", "ok", "ok", "ok"]);
		expect(engine.log).toContain('ROLLBACK TO "a"; RELEASE "a"');
		expect(engine.log.at(-1)).toBe("COMMIT");
		expect(engine.log).not.toContain("ROLLBACK");

		// Savepoints opened after the failure are skipped; closing the failed one with release still undoes it.
		engine.log.length = 0;
		expect(
			statuses(await send([begin, savepoint("a"), failing, savepoint("b"), release("b"), release("a"), { op: "commit" }], true))
		).toEqual(["ok", "ok", "constraint", "constraint", "constraint", "constraint", "ok"]);
		expect(engine.log).toEqual(["BEGIN DEFERRED", 'SAVEPOINT "a"', "INSERT fail", 'ROLLBACK TO "a"; RELEASE "a"', "COMMIT"]);

		// A savepoint that succeeds is released; a failure back at the top level rolls everything back.
		engine.log.length = 0;
		expect(statuses(await send([begin, savepoint("c"), insert(), release("c"), failing, { op: "rollback" }], true))).toEqual([
			"ok",
			"ok",
			"ok",
			"ok",
			"constraint",
			"ok"
		]);
		expect(engine.log.slice(-2)).toEqual(["INSERT fail", "ROLLBACK"]);

		// After a top-level failure, savepoint calls are skipped too.
		engine.log.length = 0;
		expect(statuses(await send([begin, failing, savepoint("d"), revert("d"), release("e"), { op: "rollback" }], true))).toEqual([
			"ok",
			"constraint",
			"constraint",
			"ok",
			"constraint",
			"ok"
		]);
		expect(engine.log).toEqual(["BEGIN DEFERRED", "INSERT fail", "ROLLBACK"]);

		// COMMIT while a failed savepoint is still open rolls the whole transaction back.
		engine.log.length = 0;
		expect(statuses(await send([begin, savepoint("f"), failing, { op: "commit" }], true))).toEqual([
			"ok",
			"ok",
			"constraint",
			"constraint"
		]);
		expect(engine.log.at(-1)).toBe("ROLLBACK");
	});

	it("stops listening", async () => {
		const { send, stop, port } = start({ connect: async () => fakeengine() });
		await send([open]);
		stop();
		const answered = vi.fn();
		port.addEventListener("message", answered);
		port.postMessage({ id: 99, tx: false, calls: [insert()] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(answered).not.toHaveBeenCalled();
	});

	it("holds a Web Lock for the worker's life when asked, and says when it can't", async () => {
		const hold = { op: "hold", name: "sqlite:x.db:worker:1" };
		// Without a hold dependency there is nothing to hold.
		expect(await start({ connect: async () => fakeengine() }).send([hold])).toEqual([{ ok: true, value: false }]);

		/** listen() on a MessageChannel, sending one hold. */
		const held = async (options) => {
			const { port1, port2 } = new MessageChannel();
			ports.push(port1, port2);
			listen(port2, options);
			const answer = new Promise((resolve) => port1.addEventListener("message", (event) => resolve(event.data.outcomes), { once: true }));
			port1.start();
			port1.postMessage({ id: 1, tx: false, calls: [hold] });
			return answer;
		};
		const granted = [];
		const manager = {
			request(name, options, callback) {
				granted.push(name);
				const result = callback({ name });
				expect(result).toBeInstanceOf(Promise);
				return result;
			}
		};
		expect(await held({ locks: manager })).toEqual([{ ok: true, value: true }]);
		expect(granted).toEqual(["sqlite:x.db:worker:1"]);
		// navigator.locks when no manager is given.
		vi.stubGlobal("navigator", { locks: manager });
		expect(await held({})).toEqual([{ ok: true, value: true }]);
		vi.stubGlobal("navigator", undefined);
		expect(await held({})).toEqual([{ ok: true, value: false }]);
		expect(await held({ locks: null })).toEqual([{ ok: true, value: false }]);
		const refusing = { request: () => Promise.reject(new DOMException("no", "NotSupportedError")) };
		expect(await held({ locks: refusing })).toEqual([{ ok: true, value: false }]);
	});

	it("listens on the worker's global scope by default", async () => {
		const listeners = [];
		vi.stubGlobal("addEventListener", (type, listener) => listeners.push(listener));
		vi.stubGlobal("removeEventListener", vi.fn());
		const posted = [];
		vi.stubGlobal("postMessage", (message) => posted.push(message));
		const stop = listen();
		listeners[0]({ data: { id: 1, tx: false, calls: [{ op: "close" }] } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(posted).toEqual([{ id: 1, outcomes: [{ ok: true, value: undefined }] }]);
		stop();
		expect(globalThis.removeEventListener).toHaveBeenCalled();
	});
});
