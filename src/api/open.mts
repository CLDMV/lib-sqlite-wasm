/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/open.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:43:39-08:00 (1795599819)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview `sqlite.open()`: resolves the storage driver, opens the connection and applies the connection
 * settings.
 *
 * Settings run in this order on every open:
 *   1. `PRAGMA locking_mode = EXCLUSIVE`, before anything reads the file. There are no xShm* methods, so a file in
 *      WAL mode only opens in exclusive mode (SQLite then keeps the WAL index in heap memory). Setting it first covers
 *      both a requested WAL journal and an existing file that is already in WAL mode.
 *   2. `PRAGMA journal_mode` (skipped for read-only connections, which can't change it).
 *   3. If the resulting mode isn't WAL, `PRAGMA locking_mode = NORMAL`, so a rollback-journal connection releases its
 *      locks between transactions as usual.
 *   4. `PRAGMA synchronous`, `PRAGMA foreign_keys`.
 */
import {
	SQLITE_BUSY,
	SQLITE_CANTOPEN,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_EXRESCODE,
	SQLITE_OPEN_READONLY,
	SQLITE_OPEN_READWRITE
} from "../core/constants.mts";
import { detect, type DriverOptions, isStorage, load, type StorageKind } from "../vfs/registry.mts";
import { type Connection, execute, query } from "./connection.mts";
import { database } from "./database.mts";
import { error } from "./error.mts";
import { type Runtime, runtime } from "./runtime.mts";

/** Where the database lives: "auto" picks files in Node, OPFS in a browser worker, memory elsewhere. */
export type storage = "auto" | "memory" | "fs" | "opfs";

/** Rollback journal or write-ahead log. */
export type journal = "wal" | "truncate" | "delete";

/** `PRAGMA synchronous` level. */
export type sync = "off" | "normal" | "full" | "extra";

/** Options for `sqlite.open()`. */
export interface options {
	/** Storage driver; default "auto". `:memory:` and "" always use memory. */
	storage?: storage;
	/** Open read-only; default false. */
	readonly?: boolean;
	/** Create the file if it doesn't exist; default true (ignored when read-only). */
	create?: boolean;
	/** Journal mode; default "wal". */
	journal?: journal;
	/** `PRAGMA synchronous`; default "normal". */
	sync?: sync;
	/** Enforce foreign keys; default true. */
	foreign?: boolean;
	/** How long to wait for a lock, in milliseconds; default 5000. */
	timeout?: number;
	/** Return every INTEGER as a bigint; default false (only integers outside ±2^53 are bigints). */
	bigint?: boolean;
	/**
	 * How other processes are kept out (Node only; browsers always use Web Locks and ignore it): "beside" (default) a
	 * `<db>.lock/` folder, falling back to "temp" where that can't be created; "temp" a folder under the OS temp
	 * folder; a folder path of your own; or "db", a row in a `_cldmv_lock` table that detects a second process but
	 * can't prevent two opening at the same instant.
	 */
	lock?: lock;
}

/** The `lock` option: "beside", "temp", "db", or a folder path. */
export type lock = string;

/** Fully resolved options. */
export interface Settings {
	storage: StorageKind;
	readonly: boolean;
	create: boolean;
	journal: journal;
	sync: sync;
	foreign: boolean;
	timeout: number;
	bigint: boolean;
	lock: string;
}

const JOURNALS: readonly string[] = ["wal", "truncate", "delete"];
const SYNCS: readonly string[] = ["off", "normal", "full", "extra"];

/** The storage kind for `path`: memory for SQLite's in-memory and temporary names, else `storage` resolved. */
export function resolveStorage(path: string, storage: storage): StorageKind {
	if (path === ":memory:" || path === "") return "memory";
	return storage === "auto" ? detect() : storage;
}

/** Validates `options` and fills in the defaults. */
export function settings(path: unknown, options: unknown): Settings {
	if (typeof path !== "string") throw new TypeError("sqlite-wasm: the path must be a string");
	if (options === null || typeof options !== "object") throw new TypeError("sqlite-wasm: options must be an object");
	const {
		storage = "auto",
		readonly = false,
		create = true,
		journal = "wal",
		sync = "normal",
		foreign = true,
		timeout = 5000,
		bigint = false,
		lock = "beside"
	} = options as options;
	if (!isStorage(storage)) throw new TypeError(`sqlite-wasm: unknown storage "${String(storage)}"`);
	for (const [name, flag] of Object.entries({ readonly, create, foreign, bigint })) {
		if (typeof flag !== "boolean") throw new TypeError(`sqlite-wasm: the ${name} option must be a boolean`);
	}
	if (!JOURNALS.includes(journal)) throw new TypeError(`sqlite-wasm: journal must be one of ${JOURNALS.join(", ")}`);
	if (!SYNCS.includes(sync)) throw new TypeError(`sqlite-wasm: sync must be one of ${SYNCS.join(", ")}`);
	if (!Number.isSafeInteger(timeout) || timeout < 0) throw new TypeError("sqlite-wasm: timeout must be a non-negative integer");
	if (typeof lock !== "string" || lock === "") throw new TypeError('sqlite-wasm: lock must be "beside", "temp", "db" or a folder path');
	return { storage: resolveStorage(path, storage), readonly, create: create && !readonly, journal, sync, foreign, timeout, bigint, lock };
}

/** Applies the connection settings (see the file overview for the order). */
function configure(connection: Connection, resolved: Settings): void {
	execute(connection, "PRAGMA locking_mode = EXCLUSIVE");
	const [row] = query(connection, resolved.readonly ? "PRAGMA journal_mode" : `PRAGMA journal_mode = ${resolved.journal}`);
	if ((row as { journal_mode: string }).journal_mode !== "wal") execute(connection, "PRAGMA locking_mode = NORMAL");
	execute(connection, `PRAGMA synchronous = ${resolved.sync}; PRAGMA foreign_keys = ${resolved.foreign ? "ON" : "OFF"}`);
}

/** A database file claimed for one connection or attachment: the name SQLite opens, the lock in effect, and how to give it back. */
export interface Claim {
	name: string;
	lock: string;
	release: () => void;
}

/**
 * Loads the driver for one database file, lets it prepare the file (when it has a `prepare` hook) and routes the
 * resulting name to it. `release()` undoes both: the route, then the driver's `release` hook.
 */
export async function claim(shared: Runtime, storage: StorageKind, options: DriverOptions): Promise<Claim> {
	const driver = await load(storage, options);
	const name = driver.prepare ? await driver.prepare(options.path, options) : options.path;
	const free = (): void => {
		// Close is synchronous: a driver's asynchronous release can't be waited for, nor its failure reported.
		Promise.resolve(driver.release?.(name)).catch(() => {});
	};
	let unroute: () => void;
	try {
		// Keyed by storage kind: two connections to one file may each bring their own driver object of the same kind.
		unroute = shared.router.register(name, driver, storage);
	} catch (thrown) {
		free();
		throw new error((thrown as Error).message, SQLITE_CANTOPEN);
	}
	return {
		name,
		lock: driver.held?.(name) ?? "none",
		release: () => {
			unroute();
			free();
		}
	};
}

/** Opens `path` with resolved settings and returns its connection state. */
export async function connect(path: string, resolved: Settings): Promise<Connection> {
	const shared = await runtime();
	const { exports, memory } = shared.instance;
	const claimed = await claim(shared, resolved.storage, {
		path,
		readonly: resolved.readonly,
		create: resolved.create,
		timeout: resolved.timeout,
		lock: resolved.lock
	});
	const release = claimed.release;

	const flags =
		(resolved.readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | (resolved.create ? SQLITE_OPEN_CREATE : 0)) | SQLITE_OPEN_EXRESCODE;
	const name = memory.allocCString(claimed.name);
	const out = memory.alloc(4);
	const rc = exports.sqlite3_open_v2(name.pointer, out, flags, 0);
	const db = memory.view().getUint32(out, true);
	memory.free(name.pointer);
	memory.free(out);
	if (rc !== SQLITE_OK) {
		const failed = new error(memory.readCString(exports.sqlite3_errmsg(db)) as string, rc);
		exports.sqlite3_close_v2(db);
		release();
		throw failed;
	}
	exports.sqlite3_busy_timeout(db, resolved.timeout);

	const connection: Connection = {
		runtime: shared,
		db,
		path,
		storage: resolved.storage,
		readonly: resolved.readonly,
		create: resolved.create,
		timeout: resolved.timeout,
		journal: resolved.journal,
		bigint: resolved.bigint,
		requested: resolved.lock,
		lock: claimed.lock,
		closing: [],
		statements: new Set(),
		routes: new Map([["main", release]])
	};
	try {
		// The "db" lock checks for another process before anything (the journal mode) is changed in the file.
		if (connection.lock === "db") await check(connection);
		configure(connection, resolved);
		if (connection.lock === "db" && !connection.readonly) await mark(connection);
	} catch (thrown) {
		exports.sqlite3_close_v2(db);
		connection.db = 0;
		release();
		throw thrown;
	}
	return connection;
}

/** The table the "db" lock keeps its rows in. */
export const LOCK_TABLE = "_cldmv_lock";
/** How often the "db" lock looks again while a live process's row is there, in ms. */
const LOCK_POLL = 25;

/** This process's host name and a liveness check for a pid on it (Node only; the "db" lock exists only there). */
async function processes(): Promise<{ host: string; alive(pid: number): boolean }> {
	const os = await import("node:os");
	return {
		host: os.hostname(),
		alive(pid: number): boolean {
			try {
				process.kill(pid, 0);
				return true;
			} catch (thrown) {
				// EPERM: the process exists but belongs to another user.
				return (thrown as NodeJS.ErrnoException).code === "EPERM";
			}
		}
	};
}

/**
 * The "db" lock: a row in `_cldmv_lock` naming the process that has the database open. Opening refuses with
 * SQLITE_BUSY (after waiting up to `timeout`) while a row names another live process on this host. A writable open
 * then removes the stale rows (dead processes, other hosts) and adds its own, which close removes again; a read-only
 * open only checks. Other connections of this process don't count as a second process. This detects a second
 * process; two processes opening at the same instant can both get through.
 */
async function check(connection: Connection): Promise<void> {
	const { host, alive } = await processes();
	// Locking first, as in configure(): a file in WAL mode only opens in exclusive mode.
	execute(connection, "PRAGMA locking_mode = EXCLUSIVE");
	const others = (): { pid: number; host: string }[] => {
		if (query(connection, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [LOCK_TABLE]).length === 0) return [];
		const rows = query(connection, `SELECT pid, host FROM ${LOCK_TABLE}`) as { pid: number; host: string }[];
		return rows.filter((each) => each.host === host && each.pid !== process.pid && alive(each.pid));
	};
	const deadline = Date.now() + connection.timeout;
	for (let live = others(); live.length > 0; live = others()) {
		if (Date.now() >= deadline) {
			const [first] = live as [{ pid: number; host: string }];
			throw new error(`database "${connection.path}" is open in process ${first.pid} on ${first.host} (lock "db")`, SQLITE_BUSY);
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL));
	}
}

/** Writes this connection's "db" lock row (see `check()`), removed again on close. */
async function mark(connection: Connection): Promise<void> {
	const { host } = await processes();
	const started = new Date().toISOString();
	execute(connection, `CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (pid INTEGER NOT NULL, host TEXT NOT NULL, started TEXT NOT NULL)`);
	query(connection, `DELETE FROM ${LOCK_TABLE} WHERE host != ? OR pid != ?`, [host, process.pid]);
	query(connection, `INSERT INTO ${LOCK_TABLE} (pid, host, started) VALUES (?, ?, ?)`, [process.pid, host, started]);
	connection.closing.push(() => {
		query(connection, `DELETE FROM ${LOCK_TABLE} WHERE pid = ? AND host = ? AND started = ?`, [process.pid, host, started]);
	});
}

/** Opens a database. */
export async function open(path: string, options: options = {}): Promise<database> {
	const resolved = settings(path, options);
	return new database(await connect(path, resolved));
}
