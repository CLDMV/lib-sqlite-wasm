/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/core/raw.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:12-08:00 (1795642212)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview A deliberately small, low-level database handle used to prove the wasm build works: open a database
 * on a VFS driver, run SQL, read rows back. The real Database / Statement API is built separately on top of the
 * loader; this helper is internal and may be removed once that exists.
 */
import {
	SQLITE_BLOB,
	SQLITE_DONE,
	SQLITE_FLOAT,
	SQLITE_INTEGER,
	SQLITE_NULL,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_EXRESCODE,
	SQLITE_OPEN_READWRITE,
	SQLITE_ROW
} from "./constants.mts";
import { instantiateSqlite, loadSqliteModule, type SqliteInstance } from "./loader.mts";
import type { VfsDriver } from "./vfs-imports.mts";
import { MemoryDriver } from "../vfs/memory.mts";

/** A column value: INTEGER as number (bigint outside the safe range), REAL, TEXT, BLOB or NULL. */
export type RawValue = number | bigint | string | Uint8Array | null;
/** A result row keyed by column name. */
export type RawRow = Record<string, RawValue>;

/** An SQLite error with its (extended) result code. */
export class RawSqliteError extends Error {
	readonly errcode: number;

	constructor(message: string, errcode: number) {
		super(message);
		this.name = "RawSqliteError";
		this.errcode = errcode;
	}
}

/** Options for `openRaw()`. */
export interface RawOpenOptions {
	/** Storage driver; a new MemoryDriver when omitted. */
	driver?: VfsDriver;
	/** A compiled sqlite3.wasm; the package's own when omitted. */
	module?: WebAssembly.Module;
	/** sqlite3_open_v2 flags; READWRITE | CREATE when omitted. */
	flags?: number;
}

/** An open connection. */
export interface RawDatabase {
	/** The module instance the connection lives in. */
	readonly sqlite: SqliteInstance;
	/** Runs every statement in `sql` and returns the rows of the last one. */
	exec(sql: string): RawRow[];
	/** Closes the connection; later calls are no-ops. */
	close(): void;
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Builds the error for result code `rc` on connection `db` (0 = no connection). */
export function sqliteError(sqlite: SqliteInstance, db: number, rc: number): RawSqliteError {
	const { exports, memory } = sqlite;
	const message = memory.readCString(db === 0 ? exports.sqlite3_errstr(rc) : exports.sqlite3_errmsg(db)) as string;
	return new RawSqliteError(message, rc);
}

/** Reads column `index` of the current row. */
function columnValue(sqlite: SqliteInstance, stmt: number, index: number): RawValue {
	const { exports, memory } = sqlite;
	switch (exports.sqlite3_column_type(stmt, index)) {
		case SQLITE_INTEGER: {
			const value = exports.sqlite3_column_int64(stmt, index);
			return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
		}
		case SQLITE_FLOAT:
			return exports.sqlite3_column_double(stmt, index);
		case SQLITE_NULL:
			return null;
		case SQLITE_BLOB: {
			// Call blob before bytes (sqlite.org/c3ref/column_blob.html); a zero-length blob has a NULL pointer.
			const pointer = exports.sqlite3_column_blob(stmt, index);
			const length = exports.sqlite3_column_bytes(stmt, index);
			return memory.bytes().slice(pointer, pointer + length);
		}
		default: {
			const pointer = exports.sqlite3_column_text(stmt, index);
			return memory.readUtf8(pointer, exports.sqlite3_column_bytes(stmt, index));
		}
	}
}

/** Steps `stmt` to completion and collects its rows. */
function collect(sqlite: SqliteInstance, db: number, stmt: number): RawRow[] {
	const { exports, memory } = sqlite;
	const count = exports.sqlite3_column_count(stmt);
	const names: string[] = [];
	for (let i = 0; i < count; i++) names.push(memory.readCString(exports.sqlite3_column_name(stmt, i)) as string);
	const rows: RawRow[] = [];
	for (;;) {
		const rc = exports.sqlite3_step(stmt);
		if (rc === SQLITE_DONE) return rows;
		if (rc !== SQLITE_ROW) throw sqliteError(sqlite, db, rc);
		const row: RawRow = {};
		for (let i = 0; i < count; i++) row[names[i] as string] = columnValue(sqlite, stmt, i);
		rows.push(row);
	}
}

/** Opens `filename` on a fresh module instance. */
export async function openRaw(filename: string, options: RawOpenOptions = {}): Promise<RawDatabase> {
	const module = options.module ?? (await loadSqliteModule());
	const sqlite = await instantiateSqlite(module, options.driver ?? new MemoryDriver());
	const { exports, memory } = sqlite;
	const flags = (options.flags ?? SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_EXRESCODE;

	const name = memory.allocCString(filename);
	const out = memory.alloc(8);
	let db = 0;
	try {
		const rc = exports.sqlite3_open_v2(name.pointer, out, flags, 0);
		db = memory.view().getUint32(out, true);
		if (rc !== SQLITE_OK) {
			const error = sqliteError(sqlite, db, rc);
			exports.sqlite3_close_v2(db);
			throw error;
		}
	} finally {
		memory.free(name.pointer);
		memory.free(out);
	}

	let open = true;
	return {
		sqlite,
		exec(sql: string): RawRow[] {
			if (!open) throw new RawSqliteError("database is closed", 21);
			const text = memory.allocCString(sql);
			const pointers = memory.alloc(8);
			const end = text.pointer + text.length;
			let rows: RawRow[] = [];
			try {
				let cursor = text.pointer;
				while (cursor < end) {
					const rc = exports.sqlite3_prepare_v2(db, cursor, end - cursor, pointers, pointers + 4);
					if (rc !== SQLITE_OK) throw sqliteError(sqlite, db, rc);
					const stmt = memory.view().getUint32(pointers, true);
					cursor = memory.view().getUint32(pointers + 4, true);
					// A trailing comment or whitespace compiles to no statement.
					if (stmt === 0) continue;
					try {
						rows = collect(sqlite, db, stmt);
					} finally {
						exports.sqlite3_finalize(stmt);
					}
				}
			} finally {
				memory.free(text.pointer);
				memory.free(pointers);
			}
			return rows;
		},
		close(): void {
			if (!open) return;
			// sqlite3_close_v2() always returns SQLITE_OK for a valid handle; unfinalized statements turn it into a zombie.
			exports.sqlite3_close_v2(db);
			open = false;
		}
	};
}
