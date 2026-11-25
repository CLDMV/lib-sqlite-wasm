/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/host.mts
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
 * @fileoverview The worker side of the main-thread client (`@cldmv/sqlite-wasm/host`).
 *
 * In the worker file:
 *
 *     import host from "@cldmv/sqlite-wasm/host";
 *     host.listen();
 *
 * The host owns one connection, on OPFS (or in memory), and answers the client's requests in arrival order. Requests
 * that pile up while it is busy are merged, and neighbouring INSERT/UPDATE/DELETE/SELECT statements from independent
 * calls run inside one transaction, so they cost one OPFS commit instead of one each. Every call still gets its own
 * result or error.
 */
import { load, type source } from "../core/browser-loader.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";
import { MemoryDriver } from "../vfs/memory.mts";
import { create, type driver, type options as opfsoptions } from "../vfs/opfs.mts";
import { open, type engine, type opening } from "./engine.mts";
import { serialize, type call, type endpoint, type failure, type outcome, type request, type settings } from "./protocol.mts";

/** Options for `listen()`: where the wasm comes from, plus the OPFS driver's options. */
export interface options extends opfsoptions {
	/** sqlite3.wasm as a URL, bytes, a Response or a compiled module; the package's own file when omitted. */
	wasm?: source;
}

/** What the host depends on; `listen()` fills it in, tests swap parts out. */
export interface dependencies {
	module(): Promise<WebAssembly.Module>;
	opfs(): driver;
	connect(name: string, options: opening): Promise<engine>;
}

/** Statements that may share a transaction with their neighbours. */
const GROUPABLE = /^\s*(insert|update|delete|replace|select|with|values)\b/i;
/** BEGIN variants a client may ask for. */
const MODES = new Set(["deferred", "immediate", "exclusive"]);
/** Journal modes and the synchronous level each gets by default. */
const JOURNALS: Record<string, string> = { wal: "NORMAL", truncate: "FULL", delete: "FULL" };

const succeed = (value: unknown): outcome => ({ ok: true, value });
const reject = (error: unknown, sql?: string): outcome => ({ ok: false, error: serialize(error, sql) });
const sqlof = (item: call): string | undefined => ("sql" in item ? item.sql : undefined);

/**
 * Applies the connection defaults: exclusive locking first (WAL needs it, since there is no shared memory), then the
 * journal mode, the matching synchronous level and foreign keys. The public `sqlite.open()` will own this.
 */
function configure(db: engine, journal: string, readonly: boolean): void {
	const sync = JOURNALS[journal];
	if (!sync) throw new RangeError(`sqlite-wasm: unknown journal mode "${journal}" (use wal, truncate or delete)`);
	db.execute("PRAGMA locking_mode = EXCLUSIVE");
	if (!readonly) db.execute(`PRAGMA journal_mode = ${journal}; PRAGMA synchronous = ${sync}`);
	db.execute("PRAGMA foreign_keys = ON");
}

/** Answers requests arriving on `scope`. Returns a function that stops listening (the database stays as it is). */
export function serve(scope: endpoint, dependencies: dependencies): () => void {
	let db: engine | undefined;
	let main: { name: string; opfs: driver | undefined } | undefined;
	const attached = new Map<string, string>();
	let tx: "none" | "open" | "aborted" = "none";
	let aborted: failure | undefined;
	const queue: request[] = [];
	let busy = false;

	const need = (): engine => {
		if (!db) throw Object.assign(new Error("sqlite-wasm: no database is open"), { number: 21 });
		return db;
	};

	const perform = async (item: call): Promise<unknown> => {
		switch (item.op) {
			case "open":
				return opendb(item.path, item.options);
			case "execute":
				return need().execute(item.sql);
			case "statement":
				return need().statement(item.sql, item.params, item.shape, item.first);
			case "columns":
				return need().columns(item.sql);
			case "attach": {
				const connection = need();
				const opfs = main?.opfs;
				const name = opfs ? await opfs.prepare(item.path) : item.path;
				try {
					connection.statement("ATTACH DATABASE ? AS ?", [name, item.schema], "run", false);
				} catch (error) {
					await opfs?.release(name);
					throw error;
				}
				if (opfs) attached.set(item.schema, name);
				return undefined;
			}
			case "detach": {
				need().statement("DETACH DATABASE ?", [item.schema], "run", false);
				const name = attached.get(item.schema);
				attached.delete(item.schema);
				if (name !== undefined) await main?.opfs?.release(name);
				return undefined;
			}
			case "begin":
				return need().execute(MODES.has(item.mode) ? `BEGIN ${item.mode.toUpperCase()}` : "BEGIN");
			case "commit":
				return need().execute("COMMIT");
			case "rollback":
				if (!need().autocommit()) need().execute("ROLLBACK");
				return undefined;
			case "close":
				return closedb();
			default:
				throw new Error(`sqlite-wasm: unknown operation "${(item as { op: unknown }).op}"`);
		}
	};

	const opendb = async (path: string, options: settings): Promise<{ path: string; storage: string }> => {
		if (db) throw Object.assign(new Error("sqlite-wasm: a database is already open in this worker"), { number: 21 });
		const storage = options.storage ?? "opfs";
		const opfs = storage === "memory" ? undefined : dependencies.opfs();
		const driver: VfsDriver = opfs ?? new MemoryDriver();
		const name = opfs ? await opfs.prepare(path, { create: options.create !== false }) : path;
		let connection: engine | undefined;
		try {
			connection = await dependencies.connect(name, {
				module: await dependencies.module(),
				driver,
				readonly: options.readonly === true,
				create: options.create !== false
			});
			configure(connection, options.journal ?? "wal", options.readonly === true);
		} catch (error) {
			connection?.close();
			await opfs?.release(name);
			throw error;
		}
		db = connection;
		main = { name, opfs };
		tx = "none";
		return { path: name, storage };
	};

	const closedb = async (): Promise<void> => {
		if (!db || !main) return;
		db.close();
		db = undefined;
		const { name, opfs } = main;
		main = undefined;
		const names = [...attached.values(), name];
		attached.clear();
		for (const each of names) await opfs?.release(each);
	};

	/** Runs consecutive groupable statements in one transaction, starting a new one if SQLite rolls one back. */
	const grouped = (connection: engine, items: Extract<call, { op: "statement" }>[]): outcome[] => {
		const results: outcome[] = [];
		let start = 0;
		/** A rolled-back transaction took the earlier writes since `start` with it: report them as failed. */
		const undo = (error: unknown): void => {
			for (let index = start; index < results.length; index++) {
				const item = items[index] as (typeof items)[number];
				if ((results[index] as outcome).ok && item.shape === "run") results[index] = reject(error, item.sql);
			}
		};
		for (const item of items) {
			if (connection.autocommit()) {
				connection.execute("BEGIN");
				start = results.length;
			}
			try {
				results.push(succeed(connection.statement(item.sql, item.params, item.shape, item.first)));
			} catch (error) {
				results.push(reject(error, item.sql));
				if (connection.autocommit()) undo(error);
			}
		}
		if (!connection.autocommit()) {
			try {
				connection.execute("COMMIT");
			} catch (error) {
				if (!connection.autocommit()) connection.execute("ROLLBACK");
				undo(error);
			}
		}
		return results;
	};

	/** Independent calls: each succeeds or fails on its own. */
	const independent = async (items: call[]): Promise<outcome[]> => {
		const results: outcome[] = [];
		for (let index = 0; index < items.length;) {
			let end = index;
			while (end < items.length && (items[end] as call).op === "statement" && GROUPABLE.test(sqlof(items[end] as call) as string)) end++;
			if (end - index >= 2 && db?.autocommit()) {
				results.push(...grouped(db, items.slice(index, end) as Extract<call, { op: "statement" }>[]));
				index = end;
				continue;
			}
			const item = items[index] as call;
			try {
				results.push(succeed(await perform(item)));
			} catch (error) {
				results.push(reject(error, sqlof(item)));
			}
			index++;
		}
		return results;
	};

	/** Calls inside a client transaction: after a failure the rest are skipped and the transaction is rolled back. */
	const transactional = async (items: call[]): Promise<outcome[]> => {
		const results: outcome[] = [];
		for (const item of items) {
			if (item.op === "begin") {
				try {
					results.push(succeed(await perform(item)));
					tx = "open";
				} catch (error) {
					const result = reject(error);
					results.push(result);
					tx = "aborted";
					aborted = (result as { error: failure }).error;
				}
				continue;
			}
			if (tx === "aborted") {
				if (item.op === "rollback" || item.op === "commit") tx = "none";
				results.push(item.op === "rollback" ? succeed(undefined) : { ok: false, error: aborted as failure });
				continue;
			}
			try {
				results.push(succeed(await perform(item)));
				if (item.op === "commit" || item.op === "rollback") tx = "none";
			} catch (error) {
				const result = reject(error, sqlof(item));
				results.push(result);
				if (db && !db.autocommit()) db.execute("ROLLBACK");
				tx = item.op === "commit" ? "none" : "aborted";
				aborted = (result as { error: failure }).error;
			}
		}
		return results;
	};

	const drain = async (): Promise<void> => {
		busy = true;
		while (queue.length > 0) {
			const batch = [queue.shift() as request];
			// Requests that queued up behind the busy host run together, so their statements can share a commit.
			if (!(batch[0] as request).tx) while (queue.length > 0 && !(queue[0] as request).tx) batch.push(queue.shift() as request);
			const items = batch.flatMap((each) => each.calls);
			let results: outcome[];
			try {
				results = (batch[0] as request).tx ? await transactional(items) : await independent(items);
			} catch (error) {
				// Something failed outside a single call (BEGIN or ROLLBACK itself): every call in the batch gets the error.
				results = items.map(() => reject(error));
			}
			let at = 0;
			for (const each of batch) {
				scope.postMessage({ id: each.id, outcomes: results.slice(at, (at += each.calls.length)) });
			}
		}
		busy = false;
	};

	const listener = (event: { data: unknown }): void => {
		queue.push(event.data as request);
		if (!busy) void drain();
	};
	scope.addEventListener("message", listener);
	scope.start?.();
	return () => scope.removeEventListener("message", listener);
}

/**
 * Starts answering the client. Call it once at the top of the worker file.
 * @param scope    where requests arrive; the worker's global scope by default
 * @param options  the wasm location and the OPFS driver's options
 */
export function listen(scope: endpoint = globalThis as unknown as endpoint, options: options = {}): () => void {
	let driver: driver | undefined;
	return serve(scope, {
		module: () => load(options.wasm),
		opfs: () => (driver ??= create(options)),
		connect: open
	});
}

/** The host as a namespace: `host.listen()`. */
const host = { listen };
export default host;
