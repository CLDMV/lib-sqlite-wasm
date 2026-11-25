/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/worker/client.mts
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:13-08:00 (1795642213)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The main-thread client (`@cldmv/sqlite-wasm/worker`): the database runs in a worker, and this side
 * offers the same methods, each returning a promise.
 *
 *     import client from "@cldmv/sqlite-wasm/worker";
 *     const db = await client.connect(new URL("./db-worker.mjs", import.meta.url), "app.sqlite3");
 *     await db.prepare("INSERT INTO t (a) VALUES (?)").run("x");
 *     drizzle(db.proxy, { schema });
 *
 * Calls made in the same tick travel to the worker as one message. While a `transaction()` callback runs, every call
 * on the connection (through `tx` or `db`, including statements prepared earlier) joins that transaction. Calls the
 * callback makes without awaiting in between go out as one batch, and a callback that never awaits mid-way costs a
 * single message: BEGIN, its statements and COMMIT together. A `transaction()` started while one runs becomes a
 * savepoint inside it: a failure there undoes only the savepoint, and the outer callback can catch it and go on.
 *
 * User-defined functions and collations run in the worker, so `db.fn.*` isn't available here; register them in the
 * host's `setup(db)` hook (see host.mts).
 *
 * With `{ share: true }`, several tabs of an origin use one database: one tab's worker opens it and the other tabs go
 * through that tab, with ownership moving on when it closes (see share.mts). `db.info.leader` says whether this tab
 * leads, and `db.info.watch(listener)` reports when that changes.
 */
import { SQLITE_MISUSE } from "../core/constants.mts";
import {
	error,
	revive,
	type call,
	type endpoint,
	type outcome,
	type parameters,
	type response,
	type settings,
	type value
} from "./protocol.mts";
import { ambient, coordinator, type watcher } from "./share.mts";

/** Options for `connect()`: the worker's open settings, and `share` to use one database from several tabs. */
export type options = settings & {
	/** Share the database with the origin's other tabs that connect with `share: true` (needs the worker's URL). */
	share?: boolean;
};

/** What `connect()` talks to: a worker script's URL (a module worker is started), or a Worker / MessagePort already running the host. */
export type target = string | URL | endpoint;

/** A row as an object keyed by column name. */
export type row = Record<string, unknown>;

/** What `run()` resolves to. */
export interface result {
	changes: number;
	rowid: number | bigint;
}

/** Row readers that return positional arrays, the first column, or objects grouped by table. */
export interface reader<item> {
	get(...params: unknown[]): Promise<item | undefined>;
	all(...params: unknown[]): Promise<item[]>;
}

/** A statement on the client. Nothing is compiled until the first call; the worker caches the compiled statement. */
export interface statement {
	run(...params: unknown[]): Promise<result>;
	get(...params: unknown[]): Promise<row | undefined>;
	all(...params: unknown[]): Promise<row[]>;
	iterate(...params: unknown[]): AsyncGenerator<row>;
	iter(...params: unknown[]): AsyncGenerator<row>;
	raw: reader<unknown[]> & {
		iterate(...params: unknown[]): AsyncGenerator<unknown[]>;
		iter(...params: unknown[]): AsyncGenerator<unknown[]>;
	};
	pluck: reader<unknown>;
	expand: reader<Record<string, row>>;
	bind(...params: unknown[]): statement;
	columns(): Promise<unknown[]>;
	cols(): Promise<unknown[]>;
	close(): void;
	info: { readonly sql: string };
}

/** The PRAGMA helpers. */
export interface pragma {
	get(name: string): Promise<unknown>;
	set(name: string, value: value): Promise<void>;
	all(name: string, argument?: value): Promise<row[]>;
}

/** What a transaction callback receives. */
export interface transaction {
	prepare(sql: string): statement;
	prep(sql: string): statement;
	execute(sql: string): Promise<void>;
	exec(sql: string): Promise<void>;
	pragma: pragma;
}

/** Runs `callback` as one transaction: committed when it resolves, rolled back when it throws. */
export interface runner {
	<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
	deferred<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
	immediate<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
	exclusive<value>(callback: (tx: transaction) => Promise<value> | value): Promise<value>;
}

/** The drizzle `sqlite-proxy` callback. */
export type proxy = (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => Promise<{ rows: unknown }>;

/** `db.fn` on the client: every method throws, since functions have to be registered in the worker. */
export interface fn {
	scalar(...ignored: unknown[]): never;
	aggregate(...ignored: unknown[]): never;
	agg(...ignored: unknown[]): never;
	collation(...ignored: unknown[]): never;
}

/** A connection to a database in a worker. */
export interface database extends transaction {
	transaction: runner;
	tx: runner;
	fn: fn;
	attach(path: string, schema: string): Promise<void>;
	detach(schema: string): Promise<void>;
	/** Copies the database (or the attached `options.schema`) into `target` in the worker's storage. */
	backup(target: string, options?: { schema?: string }): Promise<void>;
	/** The database (or attached `schema`) as the bytes of an SQLite file; the buffer is transferred from the worker. */
	serialize(schema?: string): Promise<Uint8Array>;
	checkpoint(mode?: "passive" | "full" | "restart" | "truncate"): Promise<row | undefined>;
	ckpt(mode?: "passive" | "full" | "restart" | "truncate"): Promise<row | undefined>;
	close(): Promise<void>;
	proxy: proxy;
	info: { readonly path: string; readonly storage: string; readonly lock: string; readonly open: boolean; readonly transaction: boolean };
}

/** A connection made with `share: true`: `info` also says whether this tab leads, and reports changes. */
export interface shared extends database {
	info: database["info"] & {
		/** Whether this tab's worker holds the database (the leader) or this tab goes through another tab (a follower). */
		readonly leader: boolean;
		/** Calls `listener` with the new value whenever `leader` changes; returns the function that stops it. */
		watch(listener: watcher): () => void;
	};
}

/** A call waiting to be sent, with its promise's settlers. */
interface pending {
	item: call;
	tx: boolean;
	resolve(value: unknown): void;
	reject(reason: unknown): void;
}

const noop = (): void => {};
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const CHECKPOINTS = new Set(["passive", "full", "restart", "truncate"]);

/** A misuse error (SQLITE_MISUSE), the same class as every other error the client rejects with. */
const misuse = (message: string): error => new error(message, SQLITE_MISUSE);

/** Why `db.fn.*` throws on the client. */
const FUNCTIONS =
	"user-defined functions and collations run in the worker: register them in the host's setup hook, host.listen(self, { setup(db) { db.fn.scalar(...) } })";

/** An SQL literal for a PRAGMA value. */
function literal(item: value): string {
	if (item === null) return "NULL";
	if (typeof item === "boolean") return item ? "1" : "0";
	if (typeof item === "number" || typeof item === "bigint") return String(item);
	if (typeof item === "string") return `'${item.replaceAll("'", "''")}'`;
	throw new TypeError("sqlite-wasm: a PRAGMA value must be null, a boolean, a number, a bigint or a string");
}

/** Checks a PRAGMA name (optionally schema-qualified) before it goes into SQL text. */
function pragmaname(name: string): string {
	if (!NAME.test(name)) throw new TypeError(`sqlite-wasm: invalid PRAGMA name "${name}"`);
	return name;
}

/** The message channel to the worker: batches calls per tick and matches answers to them. */
class link {
	readonly #port: endpoint;
	readonly #worker: { terminate(): void } | undefined;
	readonly #sent = new Map<number, pending[]>();
	#buffer: pending[] = [];
	#scheduled = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#next = 1;
	#closed = false;
	/** True while a transaction callback runs: new calls join the transaction. */
	intx = false;

	constructor(port: endpoint, worker: { terminate(): void } | undefined) {
		this.#port = port;
		this.#worker = worker;
		port.addEventListener("message", this.#receive);
		(port as unknown as EventTarget).addEventListener?.("error", this.#crash as EventListener);
		port.start?.();
	}

	get closed(): boolean {
		return this.#closed;
	}

	readonly #receive = (event: { data: unknown }): void => {
		const { id, outcomes } = event.data as response;
		const waiting = this.#sent.get(id);
		if (!waiting) return;
		this.#sent.delete(id);
		waiting.forEach((entry, index) => {
			const result = outcomes[index] as outcome;
			if (result.ok) entry.resolve(result.value);
			else entry.reject(revive(result.error));
		});
	};

	readonly #crash = (event: { message?: string }): void => {
		this.end(new Error(`sqlite-wasm: the worker failed${event.message ? `: ${event.message}` : ""}`));
	};

	/** Queues `item`; it is sent with everything else queued in this tick. */
	call(item: call): Promise<unknown> {
		if (this.#closed) return Promise.reject(misuse("the database is closed"));
		const promise = new Promise<unknown>((resolve, reject) => {
			this.#buffer.push({ item, tx: this.intx, resolve, reject });
		});
		if (this.intx) {
			// The transaction's own result reports a failure, so an unawaited call inside it doesn't also raise an
			// unhandled rejection.
			promise.catch(noop);
			// Inside a transaction the flush waits for the next task rather than the next microtask: a callback that
			// doesn't await mid-way has returned by then, and its COMMIT goes out in the same message.
			this.#timer ??= setTimeout(() => this.flush(), 0);
		} else if (!this.#scheduled) {
			this.#scheduled = true;
			queueMicrotask(() => this.flush());
		}
		return promise;
	}

	/** Sends what is queued: one request per run of calls with the same transaction flag. */
	flush(): void {
		this.#scheduled = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const buffer = this.#buffer;
		this.#buffer = [];
		for (let start = 0; start < buffer.length;) {
			let end = start + 1;
			while (end < buffer.length && (buffer[end] as pending).tx === (buffer[start] as pending).tx) end++;
			const group = buffer.slice(start, end);
			const id = this.#next++;
			this.#sent.set(id, group);
			this.#port.postMessage({ id, tx: (group[0] as pending).tx, calls: group.map((entry) => entry.item) });
			start = end;
		}
	}

	/** Rejects calls not yet sent (a transaction callback threw before they went out). */
	discard(reason: unknown): void {
		for (const entry of this.#buffer) entry.reject(reason);
		this.#buffer = [];
	}

	/** Stops the link: pending calls reject with `reason`, the worker (if this side started it) is terminated. */
	end(reason: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.discard(reason);
		for (const waiting of this.#sent.values()) for (const entry of waiting) entry.reject(reason);
		this.#sent.clear();
		this.#port.removeEventListener("message", this.#receive);
		this.#worker?.terminate();
	}
}

/** Wraps `connect()`'s channel in the database surface. */
function wrap(channel: link, opened: { path: string; storage: string; lock: string }): database {
	const send = (item: call): Promise<unknown> => channel.call(item);
	/**
	 * Runs `body` and returns its promise. A synchronous throw becomes a rejection, and inside a transaction the promise
	 * is marked handled: the transaction's own result reports the failure, so an unawaited call must not also raise an
	 * unhandled rejection. Nothing here is deferred, so calls keep the order they were made in.
	 */
	const attempt = <result,>(body: () => Promise<result>): Promise<result> => {
		let promise: Promise<result>;
		try {
			promise = body();
		} catch (thrown) {
			promise = Promise.reject(thrown);
		}
		if (channel.intx) promise.catch(noop);
		return promise;
	};

	const prepare = (sql: string): statement => {
		let bound: parameters | undefined;
		let closed = false;
		const args = (given: unknown[]): parameters => {
			if (bound) {
				if (given.length > 0) throw new TypeError("sqlite-wasm: parameters were already bound with bind()");
				return bound;
			}
			const only = given[0];
			if (given.length === 1 && Array.isArray(only)) return only as value[];
			if (given.length === 1 && only !== null && typeof only === "object" && !(only instanceof Uint8Array))
				return only as Record<string, value>;
			return given as value[];
		};
		const query = (shape: "run" | "object" | "raw" | "pluck" | "expand", first: boolean, given: unknown[]): Promise<never> =>
			attempt(() => {
				if (closed) throw misuse("the statement is closed");
				return send({ op: "statement", sql, params: args(given), shape, first }) as Promise<never>;
			});
		const reader = (shape: "raw" | "pluck" | "expand") => ({
			get: (...params: unknown[]) => query(shape, true, params),
			all: (...params: unknown[]) => query(shape, false, params)
		});
		const iterate = async function* (...params: unknown[]): AsyncGenerator<row> {
			yield* (await query("object", false, params)) as row[];
		};
		const rawiterate = async function* (...params: unknown[]): AsyncGenerator<unknown[]> {
			yield* (await query("raw", false, params)) as unknown[][];
		};
		const columns = (): Promise<unknown[]> =>
			attempt(() => {
				if (closed) throw misuse("the statement is closed");
				return send({ op: "columns", sql }) as Promise<unknown[]>;
			});
		const self: statement = {
			run: (...params) => query("run", false, params),
			get: (...params) => query("object", true, params),
			all: (...params) => query("object", false, params),
			iterate,
			iter: iterate,
			raw: { ...reader("raw"), iterate: rawiterate, iter: rawiterate },
			pluck: reader("pluck"),
			expand: reader("expand"),
			bind(...params) {
				if (bound) throw new TypeError("sqlite-wasm: bind() can only be called once");
				bound = args(params);
				return self;
			},
			columns,
			cols: columns,
			close() {
				closed = true;
			},
			info: { sql }
		};
		return self;
	};

	const execute = (sql: string): Promise<void> => attempt(() => send({ op: "execute", sql }).then(noop));

	const pragma: pragma = {
		get: (name) => attempt(() => send({ op: "statement", sql: `PRAGMA ${pragmaname(name)}`, params: [], shape: "pluck", first: true })),
		set: (name, item) => attempt(() => execute(`PRAGMA ${pragmaname(name)} = ${literal(item)}`)),
		all: (name, argument) =>
			attempt(
				() =>
					send({
						op: "statement",
						sql: argument === undefined ? `PRAGMA ${pragmaname(name)}` : `PRAGMA ${pragmaname(name)}(${literal(argument)})`,
						params: [],
						shape: "object",
						first: false
					}) as Promise<row[]>
			)
	};

	const tx: transaction = { prepare, prep: prepare, execute, exec: execute, pragma };

	/** A transaction started inside a running one: a savepoint, undone on its own when its callback throws. */
	let savepoints = 0;
	const nested = async <result,>(callback: (tx: transaction) => Promise<result> | result): Promise<result> => {
		const name = `sqlite_wasm_${++savepoints}`;
		void send({ op: "savepoint", name });
		let value: result;
		try {
			value = await callback(tx);
		} catch (thrown) {
			const revert = send({ op: "revert", name });
			channel.flush();
			await revert.catch(noop);
			throw thrown;
		}
		// A failure inside the savepoint that the callback didn't wait for surfaces here; the host has undone it already.
		const release = send({ op: "release", name });
		channel.flush();
		await release;
		return value;
	};

	// Transactions run one after another; a second one waits for the first to settle.
	let chain: Promise<unknown> = Promise.resolve();
	const begin = <result,>(mode: string, callback: (tx: transaction) => Promise<result> | result): Promise<result> => {
		if (channel.intx) return nested(callback);
		const run = chain.then(async () => {
			if (channel.closed) throw misuse("the database is closed");
			// Calls queued before the transaction go out first, outside it.
			channel.flush();
			channel.intx = true;
			try {
				void send({ op: "begin", mode });
				try {
					const value = await callback(tx);
					const commit = send({ op: "commit" });
					channel.flush();
					await commit;
					return value;
				} catch (thrown) {
					channel.discard(thrown);
					const rollback = send({ op: "rollback" });
					channel.flush();
					await rollback.catch(noop);
					throw thrown;
				}
			} finally {
				channel.intx = false;
			}
		});
		chain = run.catch(noop);
		return run;
	};
	const transaction = Object.assign(<result,>(callback: (tx: transaction) => Promise<result> | result) => begin("deferred", callback), {
		deferred: <result,>(callback: (tx: transaction) => Promise<result> | result) => begin("deferred", callback),
		immediate: <result,>(callback: (tx: transaction) => Promise<result> | result) => begin("immediate", callback),
		exclusive: <result,>(callback: (tx: transaction) => Promise<result> | result) => begin("exclusive", callback)
	}) as runner;

	const checkpoint = async (mode: "passive" | "full" | "restart" | "truncate" = "passive"): Promise<row | undefined> => {
		if (!CHECKPOINTS.has(mode)) throw new TypeError(`sqlite-wasm: unknown checkpoint mode "${mode}"`);
		return (await send({
			op: "statement",
			sql: `PRAGMA wal_checkpoint(${mode.toUpperCase()})`,
			params: [],
			shape: "object",
			first: true
		})) as row | undefined;
	};

	const proxy: proxy = async (sql, params, method) => {
		const values = params as value[];
		if (method === "run") {
			await send({ op: "statement", sql, params: values, shape: "run", first: false });
			return { rows: [] };
		}
		if (method === "get") return { rows: (await send({ op: "statement", sql, params: values, shape: "raw", first: true })) ?? null };
		return { rows: await send({ op: "statement", sql, params: values, shape: "raw", first: false }) };
	};

	const unavailable = (): never => {
		throw new error(FUNCTIONS, SQLITE_MISUSE);
	};
	const fn: fn = { scalar: unavailable, aggregate: unavailable, agg: unavailable, collation: unavailable };

	return {
		prepare,
		prep: prepare,
		execute,
		exec: execute,
		pragma,
		transaction,
		tx: transaction,
		fn,
		attach: async (path, schema) => {
			await send({ op: "attach", path, schema });
		},
		detach: async (schema) => {
			await send({ op: "detach", schema });
		},
		backup: async (target, options = {}) => {
			await send(options.schema === undefined ? { op: "backup", target } : { op: "backup", target, schema: options.schema });
		},
		serialize: (schema) =>
			attempt(() => send(schema === undefined ? { op: "serialize" } : { op: "serialize", schema }) as Promise<Uint8Array>),
		checkpoint,
		ckpt: checkpoint,
		close: async () => {
			if (channel.closed) return;
			await send({ op: "close" });
			channel.end(misuse("the database is closed"));
		},
		proxy,
		info: {
			path: opened.path,
			storage: opened.storage,
			lock: opened.lock,
			get open() {
				return !channel.closed;
			},
			get transaction() {
				return channel.intx;
			}
		}
	};
}

/**
 * Opens `path` in a worker running the host (`host.listen()`).
 * @param target   the worker script's URL (started as a module worker, and terminated on close), or a Worker /
 *                 MessagePort already connected to a host
 * @param path     the database path in OPFS (or a name, with `storage: "memory"`)
 * @param options  storage, journal mode, readonly, create, and `share` to share the database between tabs
 */
export function connect(target: target, path: string, options: options & { share: true }): Promise<shared>;
export function connect(target: target, path: string, options?: options): Promise<database>;
export async function connect(target: target, path: string, options: options = {}): Promise<database> {
	const { share, ...settings } = options;
	const sharing = share ? new coordinator(target, ambient(target as string)) : undefined;
	const started = !sharing && (typeof target === "string" || target instanceof URL) ? new Worker(target, { type: "module" }) : undefined;
	const channel = new link((sharing ?? started ?? target) as endpoint, started);
	try {
		const opened = (await channel.call({ op: "open", path, options: settings })) as { path: string; storage: string; lock: string };
		const db = wrap(channel, opened);
		if (sharing)
			Object.defineProperties(db.info, { leader: { get: () => sharing.leader, enumerable: true }, watch: { value: sharing.watch } });
		return db;
	} catch (thrown) {
		channel.end(thrown);
		throw thrown;
	}
}

/** The client as a namespace: `client.connect(...)`; `client.error` (alias `err`) is the class calls reject with. */
const client = { connect, error, err: error };
export default client;
export { error, error as err };
