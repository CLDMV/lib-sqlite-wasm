/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/database.mts
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
 * @fileoverview `database`: an open connection. Create one with `sqlite.open()`.
 */
import { SQLITE_DONE, SQLITE_ERROR, SQLITE_NOMEM } from "../core/constants.mts";
import { type Connection, execute, failure, handle, inTransaction, prepareOne, query } from "./connection.mts";
import { error } from "./error.mts";
import { type fn, functions } from "./functions.mts";
import { claim, connect, LOCK_TABLE, settings, type storage } from "./open.mts";
import { statement } from "./statement.mts";
import { transaction } from "./transaction.mts";
import type { value } from "./values.mts";

/** Connection state behind each database object (internal: tests and the other API modules reach it here). */
export const connections = new WeakMap<database, Connection>();

/** `db.pragma`. */
export interface pragma {
	/** The first value `PRAGMA name` returns, or undefined. */
	get(name: string): value | undefined;
	/** Runs `PRAGMA name = value` and returns the first value it returns, or undefined. */
	set(name: string, value: number | bigint | string | boolean): value | undefined;
	/** Every row `PRAGMA name` (or `PRAGMA name(argument)`) returns. */
	all(name: string, argument?: number | bigint | string | boolean): Record<string, value>[];
}

/** `db.info`. */
export interface info {
	/** The path the database was opened with. */
	readonly path: string;
	/** The storage driver it uses. */
	readonly storage: string;
	/**
	 * The cross-process lock in effect: "beside", "temp", "db" or the folder given as `lock` (node-fs), "web" (OPFS
	 * with Web Locks), "none" (memory). "beside" reads "temp" when it fell back.
	 */
	readonly lock: string;
	/** Whether it is still open. */
	readonly open: boolean;
	/** Whether a transaction is open. */
	readonly transaction: boolean;
}

/** `db.checkpoint()`'s result, straight from `PRAGMA wal_checkpoint`. */
export interface checkpoint {
	/** 1 if the checkpoint couldn't finish because of a lock. */
	busy: number;
	/** Frames in the WAL (-1 when the database isn't in WAL mode). */
	log: number;
	/** Frames copied back into the database (-1 when not in WAL mode). */
	checkpointed: number;
}

/** Checkpoint modes. */
export type mode = "passive" | "full" | "restart" | "truncate";
const MODES: readonly string[] = ["passive", "full", "restart", "truncate"];

/** A pragma name, optionally schema-qualified. Checked because pragmas can't take bound parameters. */
const PRAGMA_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*$/;

function pragmaName(name: unknown): string {
	if (typeof name !== "string" || !PRAGMA_NAME.test(name)) throw new TypeError(`sqlite-wasm: "${String(name)}" is not a pragma name`);
	return name;
}

/** An SQL literal for a pragma argument. */
function literal(input: unknown): string {
	switch (typeof input) {
		case "number":
			if (Number.isFinite(input)) return String(input);
			break;
		case "bigint":
			return String(input);
		case "boolean":
			return input ? "1" : "0";
		case "string":
			return `'${input.replaceAll("'", "''")}'`;
	}
	throw new TypeError(`sqlite-wasm: a pragma value must be a finite number, a bigint, a boolean or a string`);
}

/** A double-quoted SQL identifier. */
function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The lock for an attached database or a backup target: the main database's own, except that the "db" lock (a row in
 * the main database) becomes the default folder lock, since its row lives in one database only.
 */
function folder(requested: string): string {
	return requested === "db" ? "beside" : requested;
}

/** Checks a string argument. */
function text(input: unknown, what: string): string {
	if (typeof input !== "string") throw new TypeError(`sqlite-wasm: ${what} must be a string`);
	return input;
}

/** An open database connection. */
export class database {
	readonly #connection: Connection;
	/** Reads and sets pragmas. */
	readonly pragma: pragma;
	/** Registers user-defined functions and collations. */
	readonly fn: fn;
	/** Path, storage and state. */
	readonly info: info;

	/** @internal Use `sqlite.open()`. */
	constructor(connection: Connection) {
		this.#connection = connection;
		connections.set(this, connection);
		const first = (rows: Record<string, value>[]): value | undefined => (rows[0] ? Object.values(rows[0])[0] : undefined);
		this.pragma = Object.freeze({
			get: (name: string) => first(query(connection, `PRAGMA ${pragmaName(name)}`)),
			set: (name: string, input: number | bigint | string | boolean) =>
				first(query(connection, `PRAGMA ${pragmaName(name)} = ${literal(input)}`)),
			all: (name: string, argument?: number | bigint | string | boolean) =>
				query(connection, argument === undefined ? `PRAGMA ${pragmaName(name)}` : `PRAGMA ${pragmaName(name)}(${literal(argument)})`)
		});
		this.fn = functions(connection);
		this.info = Object.freeze({
			path: connection.path,
			storage: connection.storage,
			lock: connection.lock,
			get open() {
				return connection.db !== 0;
			},
			get transaction() {
				return inTransaction(connection);
			}
		});
	}

	/** Compiles one SQL statement. `bigint` overrides the database's option for this statement. */
	prepare(sql: string, options: { bigint?: boolean } = {}): statement {
		const pointer = prepareOne(this.#connection, text(sql, "the SQL"), true);
		return new statement(this.#connection, pointer, options.bigint ?? this.#connection.bigint);
	}

	/** Alias of `prepare`. */
	declare prep: (sql: string, options?: { bigint?: boolean }) => statement;

	/** Runs one or more SQL statements, discarding any rows. */
	execute(sql: string): this {
		execute(this.#connection, text(sql, "the SQL"));
		return this;
	}

	/** Alias of `execute`. */
	declare exec: (sql: string) => this;

	/** Wraps `callback` so each call runs in a transaction (a savepoint when nested). */
	transaction<parameters extends unknown[], output>(callback: (...parameters: parameters) => output): transaction<parameters, output> {
		return transaction(this.#connection, callback);
	}

	/** Alias of `transaction`. */
	declare tx: database["transaction"];

	/** Attaches another database file as `schema`. Uses this database's storage unless `options.storage` says otherwise. */
	async attach(path: string, schema: string, options: { storage?: storage } = {}): Promise<void> {
		const connection = this.#connection;
		handle(connection);
		text(path, "the path");
		text(schema, "the schema");
		const resolved = settings(path, { storage: options.storage ?? connection.storage });
		const { name, release } = await claim(connection.runtime, resolved.storage, {
			path,
			readonly: connection.readonly,
			create: connection.create,
			timeout: connection.timeout,
			lock: folder(connection.requested)
		});
		try {
			handle(connection);
			query(connection, "ATTACH DATABASE ? AS ?", [name, schema]);
		} catch (thrown) {
			release();
			throw thrown;
		}
		connection.routes.set(schema, release);
		if (!connection.readonly) query(connection, `PRAGMA ${identifier(schema)}.journal_mode = ${connection.journal}`);
	}

	/** Detaches the database attached as `schema`. */
	async detach(schema: string): Promise<void> {
		const connection = this.#connection;
		query(connection, "DETACH DATABASE ?", [text(schema, "the schema")]);
		connection.routes.get(schema)?.();
		connection.routes.delete(schema);
	}

	/**
	 * Copies the database (or the attached `options.schema`) into the file `target` with SQLite's backup API, replacing
	 * whatever the file held. The target uses this database's storage unless `options.storage` says otherwise.
	 */
	async backup(target: string, options: { storage?: storage; schema?: string } = {}): Promise<void> {
		const connection = this.#connection;
		handle(connection);
		const schema = text(options.schema ?? "main", "the schema");
		const destination = await connect(
			target,
			settings(target, { storage: options.storage ?? connection.storage, timeout: connection.timeout, lock: folder(connection.requested) })
		);
		const { exports, memory } = connection.runtime.instance;
		try {
			const source = handle(connection);
			const main = memory.allocCString("main");
			const from = memory.allocCString(schema);
			const backup = exports.sqlite3_backup_init(destination.db, main.pointer, source, from.pointer);
			memory.free(main.pointer);
			memory.free(from.pointer);
			if (backup === 0) throw failure(destination, exports.sqlite3_extended_errcode(destination.db));
			const rc = exports.sqlite3_backup_step(backup, -1);
			const finished = exports.sqlite3_backup_finish(backup);
			if (rc !== SQLITE_DONE) throw failure(destination, finished);
			// The copy carries the source's "db" lock rows, which name this process; the copy isn't held by anyone.
			if (query(destination, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [LOCK_TABLE]).length > 0) {
				query(destination, `DELETE FROM ${LOCK_TABLE}`);
			}
		} finally {
			new database(destination).close();
		}
	}

	/** The database (or attached `schema`) as the bytes of an SQLite file. */
	serialize(schema = "main"): Uint8Array {
		const connection = this.#connection;
		const name = text(schema, "the schema");
		if (query(connection, "SELECT 1 FROM pragma_database_list WHERE name = ?", [name]).length === 0) {
			throw new error(`unknown database schema "${name}"`, SQLITE_ERROR);
		}
		const { exports, memory } = connection.runtime.instance;
		const cname = memory.allocCString(name);
		const size = memory.alloc(8);
		memory.view().setBigInt64(size, 0n, true);
		const pointer = exports.sqlite3_serialize(connection.db, cname.pointer, size, 0);
		const length = Number(memory.view().getBigInt64(size, true));
		memory.free(cname.pointer);
		memory.free(size);
		if (pointer === 0) {
			/* v8 ignore next -- sqlite3_serialize returns NULL with a size only when its allocation fails, which the suite can't provoke */
			if (length > 0) throw new error("out of memory serializing the database", SQLITE_NOMEM);
			// An empty database that SQLite couldn't initialize (a read-only empty file): nothing to copy.
			return new Uint8Array(0);
		}
		const bytes = memory.bytes().slice(pointer, pointer + length);
		exports.sqlite3_free(pointer);
		return bytes;
	}

	/** Runs a WAL checkpoint; `mode` defaults to "passive". */
	checkpoint(mode: mode = "passive"): checkpoint {
		if (!MODES.includes(mode)) throw new TypeError(`sqlite-wasm: checkpoint mode must be one of ${MODES.join(", ")}`);
		return query(this.#connection, `PRAGMA wal_checkpoint(${mode.toUpperCase()})`)[0] as unknown as checkpoint;
	}

	/** Alias of `checkpoint`. */
	declare ckpt: (mode?: mode) => checkpoint;

	/** Finalizes every statement and closes the connection. A WAL database is checkpointed and its -wal file removed. Later calls do nothing. */
	close(): void {
		const connection = this.#connection;
		if (connection.db === 0) return;
		const { exports } = connection.runtime.instance;
		for (const hook of connection.closing.splice(0)) {
			try {
				hook();
			} catch {
				// Best effort: a lock row left behind names this process, which is stale once it exits.
			}
		}
		for (const state of connection.statements) {
			exports.sqlite3_finalize(state.pointer);
			state.pointer = 0;
		}
		connection.statements.clear();
		exports.sqlite3_close_v2(connection.db);
		connection.db = 0;
		for (const release of connection.routes.values()) release();
		connection.routes.clear();
	}
}

database.prototype.prep = database.prototype.prepare;
database.prototype.exec = database.prototype.execute;
database.prototype.tx = database.prototype.transaction;
database.prototype.ckpt = database.prototype.checkpoint;
