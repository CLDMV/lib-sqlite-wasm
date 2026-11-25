/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/drizzle.mts
 *	@Date: 2026-11-25T03:10:00-08:00 (1795605000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T03:10:00-08:00 (1795605000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Drizzle ORM on top of a sqlite-wasm database (`@cldmv/sqlite-wasm/drizzle`).
 *
 *     import sqlite from "@cldmv/sqlite-wasm";
 *     import { drizzle } from "@cldmv/sqlite-wasm/drizzle";
 *
 *     const db = drizzle(await sqlite.open("app.sqlite3"), { schema });           // Node or inside a worker: synchronous
 *     const db = drizzle(await client.connect(worker, "app.sqlite3"), { schema }); // main thread: asynchronous
 *
 * A database from `sqlite.open()` is driven by Drizzle's own better-sqlite3 session: `drizzle-orm/better-sqlite3`
 * itself can't be imported without the native better-sqlite3 package, but its session (`.../better-sqlite3/session`)
 * only calls `prepare()`, `transaction()` and a statement's `run`, `all`, `get` and `raw()`, so a small client object
 * over our database is all it needs. A client from `@cldmv/sqlite-wasm/worker` goes through Drizzle's `sqlite-proxy`
 * session with `db.proxy`, plus a `batch` callback and a `transaction()` that runs through the client's own
 * transactions, which queue concurrent ones instead of interleaving their BEGIN and COMMIT.
 *
 * Migrations: Drizzle's own `migrate()` from `drizzle-orm/better-sqlite3/migrator` works on the synchronous result as
 * is (it reads a folder, so Node and workers with a file system only). `migrate()` here takes migrations that were
 * bundled as data (`{ journal, migrations }`, the shape drizzle-kit writes for its bundled drivers) and works for both
 * kinds of database, so it also serves the browser.
 */
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { DefaultLogger, type Logger } from "drizzle-orm/logger";
import { createTableRelationsHelpers, extractTablesRelationalConfig, type TablesRelationalConfig } from "drizzle-orm/relations";
import { BaseSQLiteDatabase, SQLiteAsyncDialect, SQLiteSyncDialect, type SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import { SQLiteProxyTransaction, SQLiteRemoteSession, SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { database } from "./api/database.mts";
import type { database as client } from "./worker/client.mts";

/** Drizzle's options. `cache` isn't supported. */
export interface config<schema extends Record<string, unknown> = Record<string, never>> {
	/** `true` logs every query to the console; or pass a logger. */
	logger?: boolean | Logger;
	/** The tables and relations (`import * as schema from "./schema"`), which enables `db.query.*`. */
	schema?: schema;
	/** Column name casing, as in Drizzle's own config. */
	casing?: "snake_case" | "camelCase";
}

/** What a statement's `run()` resolves to under Drizzle (better-sqlite3's shape, which Drizzle's types use). */
export interface outcome {
	changes: number;
	lastInsertRowid: number | bigint;
}

/** A Drizzle database over a synchronous sqlite-wasm database. */
export type local<schema extends Record<string, unknown> = Record<string, never>> = BaseSQLiteDatabase<"sync", outcome, schema> & {
	$client: database;
};

/** A Drizzle database over a worker client. `batch()` runs its queries in one transaction in the worker. */
export type remote<schema extends Record<string, unknown> = Record<string, never>> = SqliteRemoteDatabase<schema> & {
	$client: client;
};

/** Migrations as data: `meta/_journal.json` and the SQL files, keyed `m0000`, `m0001`, ... */
export interface migrations {
	journal: { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };
	migrations: Record<string, string>;
}

/** Drizzle's internal pieces that the public types leave out. */
interface internals {
	dialect: { migrate(list: unknown[], session: unknown, config?: unknown): unknown };
	session: unknown;
}

/** The marker the worker client has and a plain database lacks. */
const isclient = (db: database | client): db is client => typeof (db as client).proxy === "function";

/** Drizzle's `logger` option as a Logger. */
const logger = (given: config["logger"]): Logger | undefined =>
	given === true ? new DefaultLogger() : given === false ? undefined : given;

/** Drizzle's schema bookkeeping for `db.query.*`. */
function relations(given: Record<string, unknown> | undefined) {
	if (!given) return undefined;
	const found = extractTablesRelationalConfig(given, createTableRelationsHelpers);
	return { fullSchema: given, schema: found.tables, tableNamesMap: found.tableNamesMap };
}

/** The slice of better-sqlite3 that Drizzle's session uses, written over our statements. */
function adapter(db: database) {
	return {
		prepare(sql: string) {
			const statement = db.prepare(sql);
			return {
				run(...parameters: unknown[]): outcome {
					const { changes, rowid } = statement.run(...parameters);
					return { changes, lastInsertRowid: rowid };
				},
				all: (...parameters: unknown[]) => statement.all(...parameters),
				get: (...parameters: unknown[]) => statement.get(...parameters),
				raw: () => statement.raw
			};
		},
		transaction: <output,>(callback: (...parameters: never[]) => output) => db.transaction(callback)
	};
}

/** Drizzle's sqlite-proxy session whose transactions run through the client's transaction queue. */
class session extends SQLiteRemoteSession<Record<string, unknown>, TablesRelationalConfig> {
	readonly #db: client;
	readonly #dialect: SQLiteAsyncDialect;
	readonly #schema: ReturnType<typeof relations>;

	constructor(db: client, dialect: SQLiteAsyncDialect, schema: ReturnType<typeof relations>, options: { logger?: Logger | undefined }) {
		super(db.proxy as never, dialect, schema as never, batch(db) as never, options);
		this.#db = db;
		this.#dialect = dialect;
		this.#schema = schema;
	}

	override async transaction<output>(
		callback: (tx: SQLiteProxyTransaction<Record<string, unknown>, TablesRelationalConfig>) => Promise<output>,
		config: SQLiteTransactionConfig = {}
	): Promise<output> {
		const tx = new SQLiteProxyTransaction("async", this.#dialect, this, this.#schema as never);
		return this.#db.transaction[config.behavior ?? "deferred"](() => callback(tx));
	}
}

/** The `batch` callback of sqlite-proxy: every query joins one client transaction, which goes to the worker as a batch. */
function batch(db: client) {
	return (queries: { sql: string; params: unknown[]; method: "run" | "all" | "values" | "get" }[]) =>
		db.transaction(() => Promise.all(queries.map(({ sql, params, method }) => db.proxy(sql, params, method))));
}

/**
 * Wraps `db` for Drizzle. A database from `sqlite.open()` gives a synchronous Drizzle database; a client from
 * `@cldmv/sqlite-wasm/worker` gives an asynchronous one. Drizzle's own `sqlite-proxy` also works against
 * `client.proxy` directly (`drizzle-orm/sqlite-proxy`'s `drizzle(db.proxy)`), without the batch and transaction wiring.
 */
export function drizzle<schema extends Record<string, unknown> = Record<string, never>>(
	db: database,
	config?: config<schema>
): local<schema>;
export function drizzle<schema extends Record<string, unknown> = Record<string, never>>(
	db: client,
	config?: config<schema>
): remote<schema>;
export function drizzle(db: database | client, config: config<Record<string, unknown>> = {}): unknown {
	const schema = relations(config.schema);
	const options = { logger: logger(config.logger) };
	if (isclient(db)) {
		const dialect = new SQLiteAsyncDialect({ casing: config.casing });
		const created = new SqliteRemoteDatabase("async", dialect, new session(db, dialect, schema, options), schema as never);
		return Object.assign(created, { $client: db });
	}
	const dialect = new SQLiteSyncDialect({ casing: config.casing });
	const created = new BaseSQLiteDatabase(
		"sync",
		dialect,
		new BetterSQLiteSession(adapter(db) as never, dialect, schema as never, options),
		schema as never
	);
	return Object.assign(created, { $client: db });
}

/** Applies bundled `migrations` that haven't run yet, in one transaction. Returns a promise for a worker client. */
export function migrate<schema extends Record<string, unknown>>(db: local<schema>, config: migrations): void;
export function migrate<schema extends Record<string, unknown>>(db: remote<schema>, config: migrations): Promise<void>;
export function migrate(db: unknown, config: migrations): void | Promise<void> {
	const list = config.journal.entries.map((entry) => {
		const text = config.migrations[`m${String(entry.idx).padStart(4, "0")}`];
		if (text === undefined) throw new Error(`sqlite-wasm: missing migration ${entry.tag}`);
		return { sql: text.split("--> statement-breakpoint"), bps: entry.breakpoints, folderMillis: entry.when, hash: "" };
	});
	const { dialect, session } = db as internals;
	return dialect.migrate(list, session) as void | Promise<void>;
}
