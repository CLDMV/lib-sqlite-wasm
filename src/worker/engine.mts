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
 * @fileoverview The connection the worker host drives, behind a small interface the host owns.
 *
 * This is a stopgap built straight on the loader and the wasm exports, because the spike's `openRaw()` neither binds
 * parameters nor exposes its connection pointer. Once the public Database / Statement API exists, `open()` here
 * becomes a thin adapter over `sqlite.open()` and `db.prepare()`, and the host doesn't change.
 */
import {
	SQLITE_DONE,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_EXRESCODE,
	SQLITE_OPEN_READONLY,
	SQLITE_OPEN_READWRITE,
	SQLITE_ROW
} from "../core/constants.mts";
import { instantiateSqlite, type SqliteExports, type SqliteInstance } from "../core/loader.mts";
import { RawSqliteError } from "../core/raw.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";
import type { parameters, shape, value } from "./protocol.mts";

/** Column metadata, as `statement.columns()` returns it. */
export interface column {
	name: string;
	column: string | null;
	table: string | null;
	database: string | null;
	type: string | null;
}

/** The result of a statement run for its side effects. */
export interface change {
	changes: number;
	rowid: number | bigint;
}

/** What the host needs from a connection. */
export interface engine {
	/** Runs every statement in `sql`, discarding rows. */
	execute(sql: string): void;
	/** Runs one statement. `run` returns a change; otherwise all rows, or the first row (undefined when none) with `first`. */
	statement(sql: string, params: parameters, shape: shape, first: boolean): unknown;
	/** Column metadata of the statement's result. */
	columns(sql: string): column[];
	/** Whether no transaction is open. */
	autocommit(): boolean;
	/** Finalizes cached statements and closes the connection. */
	close(): void;
}

/** Options for `open()`. */
export interface opening {
	module: WebAssembly.Module;
	driver: VfsDriver;
	readonly?: boolean;
	create?: boolean;
}

/** The exports the engine uses beyond the loader's typed set (all in EXPORTS in scripts/build-wasm.mjs). */
interface exported extends SqliteExports {
	sqlite3_reset(stmt: number): number;
	sqlite3_clear_bindings(stmt: number): number;
	sqlite3_bind_parameter_count(stmt: number): number;
	sqlite3_bind_parameter_name(stmt: number, index: number): number;
	sqlite3_bind_null(stmt: number, index: number): number;
	sqlite3_bind_int64(stmt: number, index: number, value: bigint): number;
	sqlite3_bind_double(stmt: number, index: number, value: number): number;
	sqlite3_bind_text(stmt: number, index: number, text: number, bytes: number, destructor: number): number;
	sqlite3_bind_blob(stmt: number, index: number, data: number, bytes: number, destructor: number): number;
	sqlite3_bind_zeroblob(stmt: number, index: number, bytes: number): number;
	sqlite3_column_table_name(stmt: number, index: number): number;
	sqlite3_column_origin_name(stmt: number, index: number): number;
	sqlite3_column_database_name(stmt: number, index: number): number;
	sqlite3_column_decltype(stmt: number, index: number): number;
	sqlite3_changes64(db: number): bigint;
	sqlite3_last_insert_rowid(db: number): bigint;
	sqlite3_get_autocommit(db: number): number;
}

/** SQLITE_TRANSIENT: SQLite copies the bound bytes, so the buffer can be freed right after binding. */
const TRANSIENT = -1;
/** Prepared statements kept per connection. */
const CACHE = 64;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const encoder = new TextEncoder();

/** Number when it fits, bigint otherwise. */
function integer(value: bigint): number | bigint {
	return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
}

/** Opens `name` (already prepared on the driver, for OPFS) on a fresh module instance. */
export async function open(name: string, options: opening): Promise<engine> {
	const sqlite: SqliteInstance = await instantiateSqlite(options.module, options.driver);
	const exports = sqlite.exports as exported;
	const { memory } = sqlite;
	let reported: unknown;
	const fail = (db: number, rc: number): RawSqliteError => {
		// sqlite3_errmsg() is safe on a NULL handle too (it reports out of memory, the one case that leaves it NULL).
		const message = memory.readCString(exports.sqlite3_errmsg(db)) as string;
		const error = new RawSqliteError(message, rc);
		// A driver exception was turned into this result code at the wasm boundary; keep it as the cause (once: the
		// instance keeps the last one around).
		const thrown = sqlite.lastVfsError;
		if (thrown !== undefined && thrown !== reported) {
			reported = thrown;
			Object.assign(error, { cause: thrown });
		}
		return error;
	};

	const flags =
		(options.readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | (options.create === false ? 0 : SQLITE_OPEN_CREATE)) |
		SQLITE_OPEN_EXRESCODE;
	const filename = memory.allocCString(name);
	const out = memory.alloc(8);
	let db = 0;
	try {
		const rc = exports.sqlite3_open_v2(filename.pointer, out, flags, 0);
		db = memory.view().getUint32(out, true);
		if (rc !== SQLITE_OK) {
			const error = fail(db, rc);
			exports.sqlite3_close_v2(db);
			throw error;
		}
	} finally {
		memory.free(filename.pointer);
		memory.free(out);
	}

	const cache = new Map<string, number>();
	const check = (rc: number): void => {
		if (rc !== SQLITE_OK) throw fail(db, rc);
	};

	/** Compiles the first statement in `sql`; returns 0 when there is none (blank or a comment) and `rest` past it. */
	const compile = (text: number, end: number): { stmt: number; rest: number } => {
		const pointers = memory.alloc(8);
		try {
			check(exports.sqlite3_prepare_v2(db, text, end - text, pointers, pointers + 4));
			return { stmt: memory.view().getUint32(pointers, true), rest: memory.view().getUint32(pointers + 4, true) };
		} finally {
			memory.free(pointers);
		}
	};

	/** A cached prepared statement for `sql`, compiled on first use. */
	const prepared = (sql: string): number => {
		const hit = cache.get(sql);
		if (hit !== undefined) {
			// Move to the end: the map's order is least recently used first.
			cache.delete(sql);
			cache.set(sql, hit);
			return hit;
		}
		const text = memory.allocCString(sql);
		let stmt: number;
		try {
			stmt = compile(text.pointer, text.pointer + text.length).stmt;
		} finally {
			memory.free(text.pointer);
		}
		if (stmt === 0) throw new RangeError("sqlite-wasm: the SQL contains no statement");
		cache.set(sql, stmt);
		if (cache.size > CACHE) {
			const [oldest, pointer] = cache.entries().next().value as [string, number];
			cache.delete(oldest);
			exports.sqlite3_finalize(pointer);
		}
		return stmt;
	};

	const bindone = (stmt: number, index: number, item: value | undefined): void => {
		if (item === null || item === undefined) return check(exports.sqlite3_bind_null(stmt, index));
		if (typeof item === "boolean") return check(exports.sqlite3_bind_int64(stmt, index, item ? 1n : 0n));
		if (typeof item === "number") {
			return check(
				Number.isSafeInteger(item) ? exports.sqlite3_bind_int64(stmt, index, BigInt(item)) : exports.sqlite3_bind_double(stmt, index, item)
			);
		}
		if (typeof item === "bigint") {
			if (item < MIN_INT64 || item > MAX_INT64) throw new RangeError(`sqlite-wasm: ${item} does not fit in a 64-bit integer`);
			return check(exports.sqlite3_bind_int64(stmt, index, item));
		}
		const bytes = typeof item === "string" ? encoder.encode(item) : item instanceof Uint8Array ? item : undefined;
		if (!bytes) throw new TypeError(`sqlite-wasm: cannot bind a value of type ${typeof item}`);
		if (bytes.length === 0 && typeof item !== "string") return check(exports.sqlite3_bind_zeroblob(stmt, index, 0));
		// malloc(0) may return NULL, which would bind NULL instead of an empty string; allocate at least one byte.
		const pointer = memory.alloc(Math.max(1, bytes.length));
		try {
			memory.bytes().set(bytes, pointer);
			check(
				typeof item === "string"
					? exports.sqlite3_bind_text(stmt, index, pointer, bytes.length, TRANSIENT)
					: exports.sqlite3_bind_blob(stmt, index, pointer, bytes.length, TRANSIENT)
			);
		} finally {
			memory.free(pointer);
		}
	};

	const bind = (stmt: number, params: parameters): void => {
		const count = exports.sqlite3_bind_parameter_count(stmt);
		if (Array.isArray(params)) {
			if (params.length !== count) throw new RangeError(`sqlite-wasm: the statement takes ${count} parameter(s), ${params.length} given`);
			for (let index = 1; index <= count; index++) bindone(stmt, index, params[index - 1]);
			return;
		}
		for (let index = 1; index <= count; index++) {
			const name = memory.readCString(exports.sqlite3_bind_parameter_name(stmt, index));
			// Named parameters are written :name, @name or $name; the object's keys leave the prefix off.
			const key = name === null ? undefined : name.slice(1);
			if (key === undefined || !(key in params)) throw new RangeError(`sqlite-wasm: missing named parameter ${name ?? `?${index}`}`);
			bindone(stmt, index, params[key]);
		}
	};

	const cell = (stmt: number, index: number): unknown => {
		switch (exports.sqlite3_column_type(stmt, index)) {
			case SQLITE_INTEGER:
				return integer(exports.sqlite3_column_int64(stmt, index));
			case SQLITE_FLOAT:
				return exports.sqlite3_column_double(stmt, index);
			case SQLITE_NULL:
				return null;
			case SQLITE_BLOB: {
				const pointer = exports.sqlite3_column_blob(stmt, index);
				return memory.bytes().slice(pointer, pointer + exports.sqlite3_column_bytes(stmt, index));
			}
			default:
				return memory.readUtf8(exports.sqlite3_column_text(stmt, index), exports.sqlite3_column_bytes(stmt, index));
		}
	};

	const text = (pointer: number): string | null => memory.readCString(pointer);

	const row = (stmt: number, form: shape, names: string[]): unknown => {
		if (form === "pluck") return cell(stmt, 0);
		if (form === "raw") return names.map((_, index) => cell(stmt, index));
		if (form === "expand") {
			const grouped: Record<string, Record<string, unknown>> = {};
			names.forEach((name, index) => {
				const table = text(exports.sqlite3_column_table_name(stmt, index)) ?? "$";
				(grouped[table] ??= {})[name] = cell(stmt, index);
			});
			return grouped;
		}
		const object: Record<string, unknown> = {};
		names.forEach((name, index) => {
			object[name] = cell(stmt, index);
		});
		return object;
	};

	let alive = true;
	const live = (): void => {
		if (!alive) throw new RawSqliteError("database is closed", 21);
	};

	return {
		execute(sql: string): void {
			live();
			const source = memory.allocCString(sql);
			const end = source.pointer + source.length;
			try {
				let cursor = source.pointer;
				while (cursor < end) {
					const { stmt, rest } = compile(cursor, end);
					cursor = rest;
					if (stmt === 0) continue;
					try {
						let rc: number;
						do rc = exports.sqlite3_step(stmt);
						while (rc === SQLITE_ROW);
						if (rc !== SQLITE_DONE) throw fail(db, rc);
					} finally {
						exports.sqlite3_finalize(stmt);
					}
				}
			} finally {
				memory.free(source.pointer);
			}
		},

		statement(sql: string, params: parameters, form: shape, first: boolean): unknown {
			live();
			const stmt = prepared(sql);
			try {
				bind(stmt, params);
				const count = exports.sqlite3_column_count(stmt);
				const names: string[] = [];
				for (let index = 0; index < count; index++) names.push(text(exports.sqlite3_column_name(stmt, index)) as string);
				const rows: unknown[] = [];
				for (;;) {
					const rc = exports.sqlite3_step(stmt);
					if (rc === SQLITE_DONE) break;
					if (rc !== SQLITE_ROW) throw fail(db, rc);
					if (form === "run") continue;
					rows.push(row(stmt, form, names));
					if (first) break;
				}
				if (form === "run")
					return { changes: Number(exports.sqlite3_changes64(db)), rowid: integer(exports.sqlite3_last_insert_rowid(db)) };
				return first ? rows[0] : rows;
			} finally {
				exports.sqlite3_reset(stmt);
				exports.sqlite3_clear_bindings(stmt);
			}
		},

		columns(sql: string): column[] {
			live();
			const stmt = prepared(sql);
			const result: column[] = [];
			for (let index = 0; index < exports.sqlite3_column_count(stmt); index++) {
				result.push({
					name: text(exports.sqlite3_column_name(stmt, index)) as string,
					column: text(exports.sqlite3_column_origin_name(stmt, index)),
					table: text(exports.sqlite3_column_table_name(stmt, index)),
					database: text(exports.sqlite3_column_database_name(stmt, index)),
					type: text(exports.sqlite3_column_decltype(stmt, index))
				});
			}
			return result;
		},

		autocommit(): boolean {
			return alive && exports.sqlite3_get_autocommit(db) !== 0;
		},

		close(): void {
			if (!alive) return;
			alive = false;
			for (const stmt of cache.values()) exports.sqlite3_finalize(stmt);
			cache.clear();
			exports.sqlite3_close_v2(db);
		}
	};
}
