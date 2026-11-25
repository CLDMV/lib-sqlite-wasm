/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/api/statement.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
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
 * @fileoverview `statement`: a prepared statement.
 *
 * Every execution resets the statement, binds its parameters (unless `bind()` fixed them) and steps it. `get()`
 * resets again after the first row, so a half-read statement never holds a read lock. A statement is finalized by
 * `close()`, by `db.close()`, or, if it is simply dropped, by a FinalizationRegistry once it is garbage collected.
 */
import { SQLITE_MISUSE } from "../core/constants.mts";
import { bind, columnNames, type Connection, handle, type StatementState, step } from "./connection.mts";
import { error } from "./error.mts";
import { columnValue, integer, type value } from "./values.mts";

/** A row as an object keyed by column name. */
export type row = Record<string, value>;

/** What `run()` returns. */
export interface result {
	/** Rows inserted, updated or deleted by the statement. */
	changes: number;
	/** The rowid of the last inserted row on the connection. */
	rowid: number | bigint;
}

/** One entry of `columns()`. */
export interface column {
	/** The column's name in the result (its alias, if it has one). */
	name: string;
	/** The table column it comes from, or null for an expression. */
	column: string | null;
	/** The table it comes from, or null. */
	table: string | null;
	/** The schema it comes from ("main", "temp", an attached name), or null. */
	database: string | null;
	/** The declared type, or null. */
	type: string | null;
}

/** Row shapes. */
const OBJECT = 0;
const ARRAY = 1;
const FIRST = 2;
const NESTED = 3;
type Shape = typeof OBJECT | typeof ARRAY | typeof FIRST | typeof NESTED;

/** What the safety net needs to finalize a dropped statement. Never references the statement object itself. */
interface Held {
	connection: Connection;
	state: StatementState;
}

/** Finalizes a statement whose object was garbage collected while still prepared. */
export function collect({ connection, state }: Held): void {
	if (state.pointer === 0) return;
	connection.runtime.instance.exports.sqlite3_finalize(state.pointer);
	connection.statements.delete(state);
	state.pointer = 0;
}

const registry = new FinalizationRegistry<Held>(collect);

/** `statement.raw`: rows as arrays. */
export interface raw {
	get(...parameters: unknown[]): value[] | undefined;
	all(...parameters: unknown[]): value[][];
	iterate(...parameters: unknown[]): IterableIterator<value[]>;
	/** Alias of `iterate`. */
	iter(...parameters: unknown[]): IterableIterator<value[]>;
}

/** `statement.pluck`: the first column only. */
export interface pluck {
	get(...parameters: unknown[]): value | undefined;
	all(...parameters: unknown[]): value[];
}

/** `statement.expand`: rows as `{ table: { column: value } }` ("$" for expressions). */
export interface expand {
	get(...parameters: unknown[]): Record<string, row> | undefined;
	all(...parameters: unknown[]): Record<string, row>[];
}

/** `statement.info`. */
export interface info {
	/** The SQL text. */
	readonly sql: string;
	/** Whether the statement returns rows. */
	readonly reader: boolean;
	/** Whether the statement leaves the database unchanged. */
	readonly readonly: boolean;
}

/** A prepared statement. Create one with `db.prepare()`. */
export class statement {
	readonly #connection: Connection;
	readonly #state: StatementState;
	readonly #bigint: boolean;
	#bound = false;
	#iterating = false;
	readonly #names: string[];

	/** Rows as positional arrays. */
	readonly raw: raw;
	/** The first column of each row. */
	readonly pluck: pluck;
	/** Rows grouped by source table. */
	readonly expand: expand;
	/** SQL text and kind. */
	readonly info: info;

	/** @internal Use `db.prepare()`. */
	constructor(connection: Connection, pointer: number, bigint: boolean) {
		const { exports, memory } = connection.runtime.instance;
		this.#connection = connection;
		this.#state = { pointer };
		this.#bigint = bigint;
		this.#names = columnNames(connection, pointer);
		connection.statements.add(this.#state);
		registry.register(this, { connection, state: this.#state }, this.#state);

		const iterate = (...parameters: unknown[]) => this.#iterate(ARRAY, parameters) as IterableIterator<value[]>;
		this.raw = Object.freeze({
			get: (...parameters: unknown[]) => this.#get(ARRAY, parameters) as value[] | undefined,
			all: (...parameters: unknown[]) => this.#all(ARRAY, parameters) as value[][],
			iterate,
			iter: iterate
		});
		this.pluck = Object.freeze({
			get: (...parameters: unknown[]) => this.#get(FIRST, parameters) as value | undefined,
			all: (...parameters: unknown[]) => this.#all(FIRST, parameters) as value[]
		});
		this.expand = Object.freeze({
			get: (...parameters: unknown[]) => this.#get(NESTED, parameters) as Record<string, row> | undefined,
			all: (...parameters: unknown[]) => this.#all(NESTED, parameters) as Record<string, row>[]
		});
		this.info = Object.freeze({
			sql: memory.readCString(exports.sqlite3_sql(pointer)) as string,
			reader: this.#names.length > 0,
			readonly: exports.sqlite3_stmt_readonly(pointer) !== 0
		});
	}

	/** The statement handle; throws once the statement or its database is closed. */
	#pointer(): number {
		handle(this.#connection);
		if (this.#state.pointer === 0) throw new error("statement is closed", SQLITE_MISUSE, this.info.sql);
		return this.#state.pointer;
	}

	/** Resets the statement and binds `parameters` for a new execution. */
	#start(parameters: readonly unknown[]): number {
		const pointer = this.#pointer();
		if (this.#iterating) throw new TypeError("sqlite-wasm: the statement is busy: finish or return() its iterator first");
		this.#connection.runtime.instance.exports.sqlite3_reset(pointer);
		if (this.#bound) {
			if (parameters.length > 0) throw new TypeError("sqlite-wasm: the statement's parameters were fixed with bind()");
		} else bind(this.#connection, pointer, parameters, this.info.sql);
		return pointer;
	}

	/** Throws unless the statement returns rows. */
	#reader(): void {
		if (!this.info.reader) throw new TypeError("sqlite-wasm: the statement returns no data; use run()");
	}

	/** Builds the current row in `shape`. */
	#row(pointer: number, shape: Shape): unknown {
		const instance = this.#connection.runtime.instance;
		const names = this.#names;
		const read = (i: number) => columnValue(instance, pointer, i, this.#bigint);
		switch (shape) {
			case FIRST:
				return read(0);
			case ARRAY:
				return names.map((_, i) => read(i));
			case NESTED: {
				const { exports, memory } = instance;
				const nested: Record<string, row> = {};
				names.forEach((name, i) => {
					const table = memory.readCString(exports.sqlite3_column_table_name(pointer, i)) ?? "$";
					(nested[table] ??= {})[name] = read(i);
				});
				return nested;
			}
			default: {
				const object: row = {};
				names.forEach((name, i) => (object[name] = read(i)));
				return object;
			}
		}
	}

	#get(shape: Shape, parameters: readonly unknown[]): unknown {
		this.#reader();
		const pointer = this.#start(parameters);
		const found = step(this.#connection, pointer, this.info.sql) ? this.#row(pointer, shape) : undefined;
		this.#connection.runtime.instance.exports.sqlite3_reset(pointer);
		return found;
	}

	#all(shape: Shape, parameters: readonly unknown[]): unknown[] {
		this.#reader();
		const pointer = this.#start(parameters);
		const rows: unknown[] = [];
		while (step(this.#connection, pointer, this.info.sql)) rows.push(this.#row(pointer, shape));
		this.#connection.runtime.instance.exports.sqlite3_reset(pointer);
		return rows;
	}

	#iterate(shape: Shape, parameters: readonly unknown[]): IterableIterator<unknown> {
		this.#reader();
		this.#start(parameters);
		this.#iterating = true;
		return this.#rows(shape);
	}

	*#rows(shape: Shape): Generator<unknown, void, undefined> {
		try {
			for (;;) {
				const pointer = this.#pointer();
				if (!step(this.#connection, pointer, this.info.sql)) return;
				yield this.#row(pointer, shape);
			}
		} finally {
			this.#iterating = false;
			if (this.#state.pointer !== 0) this.#connection.runtime.instance.exports.sqlite3_reset(this.#state.pointer);
		}
	}

	/** Executes the statement and returns how many rows it changed and the last inserted rowid. */
	run(...parameters: unknown[]): result {
		const pointer = this.#start(parameters);
		const { exports } = this.#connection.runtime.instance;
		while (step(this.#connection, pointer, this.info.sql));
		exports.sqlite3_reset(pointer);
		const db = this.#connection.db;
		return { changes: Number(exports.sqlite3_changes64(db)), rowid: integer(exports.sqlite3_last_insert_rowid(db), this.#bigint) };
	}

	/** The first row as an object, or undefined. */
	get(...parameters: unknown[]): row | undefined {
		return this.#get(OBJECT, parameters) as row | undefined;
	}

	/** Every row as an object. */
	all(...parameters: unknown[]): row[] {
		return this.#all(OBJECT, parameters) as row[];
	}

	/** An iterator over the rows as objects. The statement can't run again until the iterator finishes or is returned. */
	iterate(...parameters: unknown[]): IterableIterator<row> {
		return this.#iterate(OBJECT, parameters) as IterableIterator<row>;
	}

	/** Alias of `iterate`. */
	declare iter: (...parameters: unknown[]) => IterableIterator<row>;

	/** Binds `parameters` for every later execution, which must then pass none. Can be called once. */
	bind(...parameters: unknown[]): this {
		const pointer = this.#pointer();
		if (this.#bound) throw new TypeError("sqlite-wasm: the statement's parameters are already bound");
		if (this.#iterating) throw new TypeError("sqlite-wasm: the statement is busy: finish or return() its iterator first");
		this.#connection.runtime.instance.exports.sqlite3_reset(pointer);
		bind(this.#connection, pointer, parameters, this.info.sql);
		this.#bound = true;
		return this;
	}

	/** Describes the result columns. */
	columns(): column[] {
		const pointer = this.#pointer();
		const { exports, memory } = this.#connection.runtime.instance;
		return this.#names.map((name, i) => ({
			name,
			column: memory.readCString(exports.sqlite3_column_origin_name(pointer, i)),
			table: memory.readCString(exports.sqlite3_column_table_name(pointer, i)),
			database: memory.readCString(exports.sqlite3_column_database_name(pointer, i)),
			type: memory.readCString(exports.sqlite3_column_decltype(pointer, i))
		}));
	}

	/** Alias of `columns`. */
	declare cols: () => column[];

	/** Finalizes the statement. Later calls do nothing. */
	close(): void {
		registry.unregister(this.#state);
		collect({ connection: this.#connection, state: this.#state });
	}
}

statement.prototype.iter = statement.prototype.iterate;
statement.prototype.cols = statement.prototype.columns;
