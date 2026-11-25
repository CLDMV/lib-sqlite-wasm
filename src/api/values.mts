/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/values.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:20:56-08:00 (1795634456)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Converting values between JS and SQLite: statement parameters, result columns, user function
 * arguments and results.
 *
 * JS -> SQLite: null and undefined bind NULL; a safe integer binds INTEGER and any other number REAL; a bigint binds
 * INTEGER and must fit in 64 bits; a string binds TEXT (UTF-8, embedded NUL kept); a Uint8Array binds a BLOB;
 * true / false bind 1 / 0. Anything else (Date, plain objects in a value position, symbols, functions) is a TypeError.
 *
 * SQLite -> JS: INTEGER is a number when it fits in the safe range and a bigint otherwise (always a bigint in bigint
 * mode); REAL is a number; TEXT a string; BLOB a fresh Uint8Array; NULL null.
 */
import { SQLITE_BLOB, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL, SQLITE_OK } from "../core/constants.mts";
import type { SqliteInstance } from "../core/loader.mts";

/** A value SQLite stores. */
export type value = null | number | bigint | string | Uint8Array;

/** SQLITE_TRANSIENT: SQLite copies the bytes before the call returns. */
const TRANSIENT = -1;

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/** Converts an INTEGER read from SQLite. */
export function integer(raw: bigint, bigint: boolean): number | bigint {
	return bigint || raw < MIN_SAFE || raw > MAX_SAFE ? raw : Number(raw);
}

/** Checks that `raw` fits in a signed 64-bit integer. */
function int64(raw: bigint): bigint {
	if (raw < MIN_INT64 || raw > MAX_INT64) throw new RangeError(`sqlite-wasm: ${raw} does not fit in a 64-bit integer`);
	return raw;
}

/** The TypeError for a value SQLite can't store. */
function unsupported(input: unknown): TypeError {
	const kind =
		input instanceof Date
			? "a Date"
			: typeof input === "object"
				? `an object (${Object.prototype.toString.call(input)})`
				: `a ${typeof input}`;
	return new TypeError(`sqlite-wasm: cannot store ${kind}; use null, a number, a bigint, a string, a boolean or a Uint8Array`);
}

/** The setters for one destination (a statement parameter or a function result). */
interface Sink {
	null(): number;
	int64(raw: bigint): number;
	double(raw: number): number;
	text(pointer: number, bytes: number): number;
	blob(pointer: number, bytes: number): number;
	empty(): number;
}

/** Stores `input` through `sink`, copying strings and blobs through a temporary allocation. */
function store(instance: SqliteInstance, sink: Sink, input: unknown): number {
	const { memory } = instance;
	if (input === null || input === undefined) return sink.null();
	switch (typeof input) {
		case "number":
			return Number.isSafeInteger(input) ? sink.int64(BigInt(input)) : sink.double(input);
		case "bigint":
			return sink.int64(int64(input));
		case "boolean":
			return sink.int64(input ? 1n : 0n);
		case "string": {
			const text = memory.allocCString(input);
			try {
				return sink.text(text.pointer, text.length);
			} finally {
				memory.free(text.pointer);
			}
		}
	}
	if (!(input instanceof Uint8Array)) throw unsupported(input);
	// sqlite3_bind_blob / sqlite3_result_blob treat a NULL pointer as SQL NULL, so an empty blob takes the zeroblob path.
	if (input.length === 0) return sink.empty();
	const pointer = memory.alloc(input.length);
	try {
		memory.bytes().set(input, pointer);
		return sink.blob(pointer, input.length);
	} finally {
		memory.free(pointer);
	}
}

/** Binds `input` to parameter `index` (1-based) of `stmt`; returns SQLite's result code. */
export function bindValue(instance: SqliteInstance, stmt: number, index: number, input: unknown): number {
	const { exports } = instance;
	return store(
		instance,
		{
			null: () => exports.sqlite3_bind_null(stmt, index),
			int64: (raw) => exports.sqlite3_bind_int64(stmt, index, raw),
			double: (raw) => exports.sqlite3_bind_double(stmt, index, raw),
			text: (pointer, bytes) => exports.sqlite3_bind_text(stmt, index, pointer, bytes, TRANSIENT),
			blob: (pointer, bytes) => exports.sqlite3_bind_blob(stmt, index, pointer, bytes, TRANSIENT),
			empty: () => exports.sqlite3_bind_zeroblob(stmt, index, 0)
		},
		input
	);
}

/** Sets `input` as the result of the user function call `context`. */
export function setResult(instance: SqliteInstance, context: number, input: unknown): void {
	const { exports } = instance;
	/** Runs a void sqlite3_result_* call and reports success, so it fits the Sink shape. */
	const ok = (call: () => void) => (): number => {
		call();
		return SQLITE_OK;
	};
	store(
		instance,
		{
			null: ok(() => exports.sqlite3_result_null(context)),
			int64: (raw) => ok(() => exports.sqlite3_result_int64(context, raw))(),
			double: (raw) => ok(() => exports.sqlite3_result_double(context, raw))(),
			text: (pointer, bytes) => ok(() => exports.sqlite3_result_text(context, pointer, bytes, TRANSIENT))(),
			blob: (pointer, bytes) => ok(() => exports.sqlite3_result_blob(context, pointer, bytes, TRANSIENT))(),
			empty: ok(() => exports.sqlite3_result_zeroblob(context, 0))
		},
		input
	);
}

/** Whether `input` is a bag of named parameters (a plain object). */
function isNamed(input: unknown): input is Record<string, unknown> {
	if (typeof input !== "object" || input === null) return false;
	const prototype = Object.getPrototypeOf(input);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Binds `parameters` to every parameter of `stmt`. Arguments are positional values, arrays of positional values, or
 * one plain object of named values (keys without the `:`, `@` or `$` prefix). Anonymous parameters (`?`, `?NNN`) take
 * the positional values in order. Every parameter must get a value and every positional value must be used.
 * Returns SQLite's result code from the first bind that failed, or SQLITE_OK.
 */
export function bindAll(instance: SqliteInstance, stmt: number, parameters: readonly unknown[]): number {
	const { exports, memory } = instance;
	const positional: unknown[] = [];
	let named: Record<string, unknown> | undefined;
	for (const parameter of parameters) {
		if (Array.isArray(parameter)) positional.push(...parameter);
		else if (isNamed(parameter)) {
			if (named) throw new TypeError("sqlite-wasm: pass named parameters in a single object");
			named = parameter;
		} else positional.push(parameter);
	}
	const count = exports.sqlite3_bind_parameter_count(stmt);
	let next = 0;
	for (let index = 1; index <= count; index++) {
		const name = memory.readCString(exports.sqlite3_bind_parameter_name(stmt, index));
		let input: unknown;
		if (name === null || name.startsWith("?")) {
			if (next >= positional.length) throw new RangeError(`sqlite-wasm: too few parameter values (the statement has ${count} parameters)`);
			input = positional[next++];
		} else {
			const key = name.slice(1);
			if (!named || !Object.hasOwn(named, key)) throw new RangeError(`sqlite-wasm: missing named parameter "${key}"`);
			input = named[key];
		}
		const rc = bindValue(instance, stmt, index, input);
		if (rc !== SQLITE_OK) return rc;
	}
	if (next < positional.length) throw new RangeError(`sqlite-wasm: too many parameter values (the statement takes ${next})`);
	return SQLITE_OK;
}

/** Accessors for one value (a result column or a function argument). */
interface Source {
	type(): number;
	int64(): bigint;
	double(): number;
	text(): number;
	blob(): number;
	bytes(): number;
}

/** Reads one value through `source`. */
function read(instance: SqliteInstance, source: Source, bigint: boolean): value {
	switch (source.type()) {
		case SQLITE_INTEGER:
			return integer(source.int64(), bigint);
		case SQLITE_FLOAT:
			return source.double();
		case SQLITE_NULL:
			return null;
		case SQLITE_BLOB: {
			// The pointer first, then the length (sqlite.org/c3ref/column_blob.html); an empty blob has a NULL pointer.
			const at = source.blob();
			return instance.memory.bytes().slice(at, at + source.bytes());
		}
		default: {
			const at = source.text();
			return instance.memory.readUtf8(at, source.bytes());
		}
	}
}

/** Column `index` of the current row of `stmt`. */
export function columnValue(instance: SqliteInstance, stmt: number, index: number, bigint: boolean): value {
	const { exports } = instance;
	return read(
		instance,
		{
			type: () => exports.sqlite3_column_type(stmt, index),
			int64: () => exports.sqlite3_column_int64(stmt, index),
			double: () => exports.sqlite3_column_double(stmt, index),
			text: () => exports.sqlite3_column_text(stmt, index),
			blob: () => exports.sqlite3_column_blob(stmt, index),
			bytes: () => exports.sqlite3_column_bytes(stmt, index)
		},
		bigint
	);
}

/** The `argc` arguments at `argv` of a user function call. */
export function argumentValues(instance: SqliteInstance, argc: number, argv: number, bigint: boolean): value[] {
	const { exports, memory } = instance;
	const values: value[] = [];
	for (let i = 0; i < argc; i++) {
		const handle = memory.view().getUint32(argv + i * 4, true);
		values.push(
			read(
				instance,
				{
					type: () => exports.sqlite3_value_type(handle),
					int64: () => exports.sqlite3_value_int64(handle),
					double: () => exports.sqlite3_value_double(handle),
					text: () => exports.sqlite3_value_text(handle),
					blob: () => exports.sqlite3_value_blob(handle),
					bytes: () => exports.sqlite3_value_bytes(handle)
				},
				bigint
			)
		);
	}
	return values;
}
