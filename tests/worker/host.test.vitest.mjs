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
import { loadSqliteModule } from "../../src/core/loader.mts";

const module = await loadSqliteModule();
const ports = [];

afterEach(() => {
	for (const port of ports.splice(0)) port.close();
	vi.unstubAllGlobals();
});

/** A connection whose transaction state follows BEGIN / COMMIT / ROLLBACK, with hooks to make calls fail. */
function fakeengine(hooks = {}) {
	const state = { auto: true, log: [] };
	return Object.assign(state, {
		execute(sql) {
			state.log.push(sql);
			hooks.execute?.(sql, state);
			if (/^BEGIN/.test(sql)) state.auto = false;
			if (/^(COMMIT|ROLLBACK)/.test(sql)) state.auto = true;
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
	const stop = serve(port2, {
		module: async () => module,
		opfs: () => {
			throw new Error("no OPFS in this test");
		},
		...dependencies
	});
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
		expect(statuses(await send([{ op: "bogus" }]))).toEqual(['sqlite-wasm: unknown operation "bogus"']);
		expect(statuses(await send([insert(), insert()]))).toEqual(["sqlite-wasm: no database is open", "sqlite-wasm: no database is open"]);
		expect(statuses(await send([insert()], true))).toEqual(["sqlite-wasm: no database is open"]);
		// Closing with nothing open is a no-op.
		expect(statuses(await send([{ op: "close" }]))).toEqual(["ok"]);
	});

	it("refuses a second open and closes the connection when configuring it fails", async () => {
		const engine = fakeengine();
		const { send } = start({ connect: async () => engine });
		expect(statuses(await send([open, open]))).toEqual(["ok", "sqlite-wasm: a database is already open in this worker"]);
		await send([{ op: "close" }]);
		const [failed] = await send([{ ...open, options: { storage: "memory", journal: "bogus" } }]);
		expect(failed.error).toMatchObject({ name: "RangeError" });
		expect(engine.log.filter((entry) => entry === "close")).toHaveLength(2);
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

	it("releases an OPFS database when the connection cannot be made", async () => {
		const released = [];
		const opfs = { prepare: async (path) => `/${path}`, release: async (name) => released.push(name) };
		const { send } = start({
			opfs: () => opfs,
			connect: async () => {
				throw new Error("no module");
			}
		});
		expect(statuses(await send([{ op: "open", path: "x.db", options: {} }]))).toEqual(["no module"]);
		expect(released).toEqual(["/x.db"]);
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
