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
 *     host.listen(self, {
 *         // Optional: runs after the database opens, with the full synchronous API. User-defined functions and
 *         // collations are registered here, since they run in the worker.
 *         setup(db) {
 *             db.fn.scalar("slugify", (text) => text.toLowerCase().replaceAll(" ", "-"), { deterministic: true });
 *         }
 *     });
 *
 * The host owns one connection, opened with `sqlite.open()` on OPFS (or in memory), and answers the client's requests
 * in arrival order. Requests that pile up while it is busy are merged, and neighbouring INSERT/UPDATE/DELETE/SELECT
 * statements from independent calls run inside one transaction, so they cost one OPFS commit instead of one each.
 * Every call still gets its own result or error. The connection settings (exclusive locking, journal mode,
 * synchronous, foreign keys) are `sqlite.open()`'s, applied there.
 */
import { SQLITE_MISUSE } from "../core/constants.mts";
import { load, type source } from "../core/browser-loader.mts";
import { error } from "../api/error.mts";
import type { database } from "../api/database.mts";
import { use } from "../api/runtime.mts";
import * as opfs from "../vfs/opfs.mts";
import type { locks, options as opfsoptions } from "../vfs/opfs.mts";
import { install } from "../vfs/registry.mts";
import { open, type engine } from "./engine.mts";
import { serialize, type call, type endpoint, type failure, type outcome, type request, type settings } from "./protocol.mts";

/** Options for `listen()`: where the wasm comes from, the OPFS driver's options, and a hook run after open. */
export interface options extends Omit<opfsoptions, "timeout"> {
	/** sqlite3.wasm as a URL, bytes, a Response or a compiled module; the package's own file when omitted. */
	wasm?: source;
	/** Runs after each open with the database (register functions and collations here); a throw fails the open. */
	setup?: (db: database) => unknown;
}

/** What the host depends on; `listen()` fills it in, tests swap parts out. */
export interface dependencies {
	connect(path: string, settings: settings): Promise<engine>;
	setup?: (db: database) => unknown;
	/**
	 * Takes the Web Lock `name` for the rest of the worker's life; resolves to whether it could (false without Web
	 * Locks). A shared connection's leader tab waits on the same lock to learn that its worker is gone.
	 */
	hold?: (name: string) => Promise<boolean>;
}

/** Statements that may share a transaction with their neighbours. */
const GROUPABLE = /^\s*(insert|update|delete|replace|select|with|values)\b/i;
/** BEGIN variants a client may ask for. */
const MODES = new Set(["deferred", "immediate", "exclusive"]);

const succeed = (value: unknown): outcome => ({ ok: true, value });
const reject = (thrown: unknown, sql?: string): outcome => ({ ok: false, error: serialize(thrown, sql) });
const sqlof = (item: call): string | undefined => ("sql" in item ? item.sql : undefined);
/** A savepoint name as an SQL identifier. */
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Answers requests arriving on `scope`. Returns a function that stops listening (the database stays as it is). */
export function serve(scope: endpoint, dependencies: dependencies): () => void {
	let db: engine | undefined;
	/** The client transaction: none, open, or aborted at a savepoint depth (0 is the transaction itself). */
	let tx: "none" | "open" | "aborted" = "none";
	/** Savepoints open inside the client transaction. */
	let depth = 0;
	/** The savepoint depth an abort applies to, savepoints the client opened after it, and the failure it reports. */
	let abortedat = 0;
	let skipped = 0;
	let aborted: failure | undefined;
	const queue: request[] = [];
	let busy = false;

	const need = (): engine => {
		if (!db) throw new error("no database is open", SQLITE_MISUSE);
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
			case "attach":
				return need().db.attach(item.path, item.schema);
			case "detach":
				return need().db.detach(item.schema);
			case "backup":
				return need().db.backup(item.target, item.schema === undefined ? {} : { schema: item.schema });
			case "serialize":
				return need().db.serialize(item.schema);
			case "begin":
				return need().execute(MODES.has(item.mode) ? `BEGIN ${item.mode.toUpperCase()}` : "BEGIN");
			case "commit":
				return need().execute("COMMIT");
			case "rollback":
				if (!need().autocommit()) need().execute("ROLLBACK");
				return undefined;
			case "savepoint":
				return need().execute(`SAVEPOINT ${quoted(item.name)}`);
			case "release":
				return need().execute(`RELEASE ${quoted(item.name)}`);
			case "revert":
				return need().execute(`ROLLBACK TO ${quoted(item.name)}; RELEASE ${quoted(item.name)}`);
			case "close":
				return closedb();
			case "hold":
				return dependencies.hold ? dependencies.hold(item.name) : false;
			default:
				throw new error(`unknown operation "${(item as { op: unknown }).op}"`, SQLITE_MISUSE);
		}
	};

	const opendb = async (path: string, options: settings): Promise<{ path: string; storage: string; lock: string }> => {
		if (db) throw new error("a database is already open in this worker", SQLITE_MISUSE);
		const connection = await dependencies.connect(path, options);
		try {
			await dependencies.setup?.(connection.db);
		} catch (thrown) {
			await connection.close();
			throw thrown;
		}
		db = connection;
		tx = "none";
		depth = 0;
		const { info } = connection.db;
		return { path: info.path, storage: info.storage, lock: info.lock };
	};

	const closedb = async (): Promise<void> => {
		const closing = db?.close();
		db = undefined;
		// Answered once the files are released, so the client can reopen (here or in another tab) straight away.
		await closing;
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

	/**
	 * Calls inside a client transaction: after a failure the rest are skipped. A failure in the transaction itself
	 * rolls it back; a failure inside a savepoint rolls back to that savepoint and skips only until the client closes
	 * it, after which the outer transaction goes on.
	 */
	const transactional = async (items: call[]): Promise<outcome[]> => {
		const results: outcome[] = [];
		const abort = (result: outcome): void => {
			tx = "aborted";
			abortedat = depth;
			skipped = 0;
			aborted = (result as { error: failure }).error;
		};
		/** A call after a failure: skipped, except the calls that close the failed level. */
		const skip = (item: call): outcome => {
			const report: outcome =
				item.op === "rollback" || item.op === "revert" ? succeed(undefined) : { ok: false, error: aborted as failure };
			if (item.op === "savepoint") skipped++;
			else if ((item.op === "release" || item.op === "revert") && skipped > 0) skipped--;
			else if ((item.op === "release" || item.op === "revert") && abortedat > 0) {
				// The failed savepoint closes: undo it, and the level around it goes on.
				need().execute(`ROLLBACK TO ${quoted(item.name)}; RELEASE ${quoted(item.name)}`);
				depth--;
				tx = "open";
			} else if (item.op === "commit" || item.op === "rollback") {
				// Ending the transaction while a failed savepoint is still open: nothing of it may be kept. (A failure at the
				// top level was rolled back already, and a failed BEGIN leaves a transaction that isn't this one's.)
				if (abortedat > 0) need().execute("ROLLBACK");
				tx = "none";
			}
			return report;
		};
		for (const item of items) {
			if (item.op === "begin") {
				try {
					results.push(succeed(await perform(item)));
					tx = "open";
					depth = 0;
				} catch (thrown) {
					const result = reject(thrown);
					results.push(result);
					depth = 0;
					abort(result);
				}
				continue;
			}
			if (tx === "aborted") {
				results.push(skip(item));
				continue;
			}
			try {
				results.push(succeed(await perform(item)));
				if (item.op === "commit" || item.op === "rollback") tx = "none";
				if (item.op === "savepoint") depth++;
				if (item.op === "release" || item.op === "revert") depth--;
			} catch (thrown) {
				const result = reject(thrown, sqlof(item));
				results.push(result);
				if (item.op === "commit") {
					if (db && !db.autocommit()) db.execute("ROLLBACK");
					tx = "none";
				} else if (depth > 0) abort(result);
				else {
					if (db && !db.autocommit()) db.execute("ROLLBACK");
					abort(result);
				}
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
				const outcomes = results.slice(at, (at += each.calls.length));
				// A serialized database is handed over, not copied.
				const transfer = outcomes.flatMap((result) => (result.ok && result.value instanceof Uint8Array ? [result.value.buffer] : []));
				scope.postMessage({ id: each.id, outcomes }, transfer);
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
 * @param options  the wasm location, the OPFS driver's options, and the `setup(db)` hook
 */
export function listen(scope: endpoint = globalThis as unknown as endpoint, options: options = {}): () => void {
	const { wasm, setup, ...driver } = options;
	const lockmanager =
		driver.locks === undefined ? (globalThis as unknown as { navigator?: { locks?: locks } }).navigator?.locks : driver.locks;
	// The host always needs the OPFS driver, so it is bundled with it and registered here rather than imported on first
	// open (a lazy import() inside a worker also trips up test runners that rewrite dynamic imports).
	install("opfs", () => Promise.resolve(opfs));
	// The first open in this worker creates the shared module instance, from this wasm when one is given (otherwise
	// the package's own file: fetched in a browser, read from disk in Node).
	if (wasm !== undefined) use(() => load(wasm));
	return serve(scope, {
		connect: (path, settings) => open(path, { ...settings, storage: settings.storage ?? "opfs" }, driver),
		// The lock is never let go: the browser releases it when the worker ends, however it ends.
		hold: (name) =>
			new Promise<boolean>((resolve) => {
				if (!lockmanager) return resolve(false);
				lockmanager
					.request(name, {}, () => {
						resolve(true);
						return new Promise<void>(() => {});
					})
					.catch(() => resolve(false));
			}),
		...(setup === undefined ? {} : { setup })
	});
}

/** The host as a namespace: `host.listen()`. */
const host = { listen };
export default host;
