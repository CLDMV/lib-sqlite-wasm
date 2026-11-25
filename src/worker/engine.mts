/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/engine.mts
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
 * @fileoverview The connection the worker host drives: the public API (`sqlite.open()`, `db.prepare()`) behind the
 * small interface the host's batching works against. Statements are prepared once per SQL text and kept in a
 * least-recently-used cache, since the client sends SQL text rather than statement handles.
 */
import { connections, database } from "../api/database.mts";
import { connect, settings as resolve, type options } from "../api/open.mts";
import type { column, statement } from "../api/statement.mts";
import type { parameters, shape } from "./protocol.mts";

/** Column metadata, as `statement.columns()` returns it. */
export type { column };

/** What the host needs from a connection. */
export interface engine {
	/** The database itself (the host's `setup` hook and the operations without a shortcut here use it). */
	readonly db: database;
	/** Runs every statement in `sql`, discarding rows. */
	execute(sql: string): void;
	/** Runs one statement. `run` returns a change; otherwise all rows, or the first row (undefined when none) with `first`. */
	statement(sql: string, params: parameters, shape: shape, first: boolean): unknown;
	/** Column metadata of the statement's result. */
	columns(sql: string): column[];
	/** Whether no transaction is open. */
	autocommit(): boolean;
	/** Closes the cached statements and the connection; settles when its files are released (OPFS handles, locks). */
	close(): Promise<void>;
}

/** Prepared statements kept per connection. */
const CACHE = 64;

/**
 * Opens `path` through the public API. `extra` reaches the storage driver along with the options (the host's OPFS
 * root, lock manager and wait).
 */
export async function open(path: string, options: options, extra: Record<string, unknown> = {}): Promise<engine> {
	const db = new database(await connect(path, resolve(path, options), extra));
	const cache = new Map<string, statement>();

	/** A cached prepared statement for `sql`, compiled on first use. */
	const prepared = (sql: string): statement => {
		const hit = cache.get(sql);
		if (hit !== undefined) {
			// Move to the end: the map's order is least recently used first.
			cache.delete(sql);
			cache.set(sql, hit);
			return hit;
		}
		const made = db.prepare(sql);
		cache.set(sql, made);
		if (cache.size > CACHE) {
			const [oldest, dropped] = cache.entries().next().value as [string, statement];
			cache.delete(oldest);
			dropped.close();
		}
		return made;
	};

	return {
		db,
		execute(sql: string): void {
			db.execute(sql);
		},

		statement(sql: string, params: parameters, form: shape, first: boolean): unknown {
			const made = prepared(sql);
			switch (form) {
				case "run":
					return made.run(params);
				case "object":
					return first ? made.get(params) : made.all(params);
				default:
					return first ? made[form].get(params) : made[form].all(params);
			}
		},

		columns(sql: string): column[] {
			return prepared(sql).columns();
		},

		autocommit(): boolean {
			return !db.info.transaction;
		},

		close(): Promise<void> {
			cache.clear();
			db.close();
			return (connections.get(db) as { closed: Promise<void> }).closed;
		}
	};
}
