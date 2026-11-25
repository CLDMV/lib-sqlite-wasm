/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/functions.mts
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
 * @fileoverview `db.fn`: user-defined scalar functions, aggregates, window functions and collations.
 *
 * Each one is registered through glue.c's trampolines with an id from the instance's callback table. SQLite tells
 * the table to forget the id (cb_destroy) when the function is replaced or deleted or the connection closes.
 *
 * A callback that throws makes the statement fail with that same exception: the handler reports the failure to
 * SQLite (sqlite3_result_error) so the statement stops, keeps the exception, and `step()` rethrows it.
 */
import type { CallbackHandler } from "../core/callbacks.mts";
import { SQLITE_OK } from "../core/constants.mts";
import { type Connection, failure, handle } from "./connection.mts";
import { argumentValues, setResult, type value } from "./values.mts";

/** sqlite3_create_function flags. */
const SQLITE_UTF8 = 1;
const SQLITE_DETERMINISTIC = 0x800;

/** Function kinds understood by glue.c's cldmv_create_function. */
const SCALAR = 0;
const AGGREGATE = 1;
const WINDOW = 2;

/** Options shared by scalar and aggregate functions. */
export interface options {
	/** Same arguments always give the same result (lets SQLite use the function in indexes and optimize it). */
	deterministic?: boolean;
	/** Accept any number of arguments instead of the callback's declared parameter count. */
	variadic?: boolean;
	/** Pass INTEGER arguments as bigint; defaults to the database's `bigint` option. */
	bigint?: boolean;
}

/** An aggregate (or, with `inverse`, a window function). */
export interface aggregate extends options {
	/** The initial accumulator, or a function returning a fresh one for each group. Defaults to null. */
	start?: unknown;
	/** Folds one row into the accumulator and returns the new one (returning undefined keeps the current one). */
	step: (total: never, ...values: value[]) => unknown;
	/** Removes a row that left the window frame; makes the aggregate usable as a window function. */
	inverse?: (total: never, ...values: value[]) => unknown;
	/** Turns the accumulator into the result; the accumulator itself when omitted. */
	result?: (total: never) => unknown;
}

/** The `db.fn` namespace. */
export interface fn {
	/** Registers a scalar function. */
	scalar(name: string, callback: (...values: value[]) => unknown, options?: options): void;
	/** Registers an aggregate, or a window function when `inverse` is given. */
	aggregate(name: string, definition: aggregate): void;
	/** Alias of `aggregate`. */
	agg(name: string, definition: aggregate): void;
	/** Registers a collation: `compare` returns a negative number, zero or a positive number. */
	collation(name: string, compare: (a: string, b: string) => number): void;
}

/** Checks a function or collation name. */
function checkName(name: unknown): asserts name is string {
	if (typeof name !== "string" || name.length === 0) throw new TypeError("sqlite-wasm: the name must be a non-empty string");
}

/** Checks that `callback` is a function. */
function checkFunction(callback: unknown, what: string): asserts callback is (...args: never[]) => unknown {
	if (typeof callback !== "function") throw new TypeError(`sqlite-wasm: ${what} must be a function`);
}

/** Builds the `db.fn` namespace for `connection`. */
export function functions(connection: Connection): fn {
	const { runtime } = connection;
	const { instance } = runtime;
	const { exports, memory } = instance;

	/** Keeps `thrown` for step() and stops the statement. */
	const report = (context: number, thrown: unknown): void => {
		// The first exception of a statement wins; SQLite may call more callbacks while it unwinds.
		runtime.pending ??= { error: thrown };
		const text = memory.allocCString(thrown instanceof Error ? thrown.message : String(thrown));
		exports.sqlite3_result_error(context, text.pointer, text.length);
		memory.free(text.pointer);
	};

	/** Registers `handler` under `name`. */
	const register = (name: string, argc: number, flags: number, kind: number, handler: CallbackHandler): void => {
		const db = handle(connection);
		const id = instance.callbacks.add(handler);
		const text = memory.allocCString(name);
		// On failure SQLite has already called cb_destroy for the id.
		const rc = exports.cldmv_create_function(db, text.pointer, argc, flags, id, kind);
		memory.free(text.pointer);
		if (rc !== SQLITE_OK) throw failure(connection, rc);
	};

	const flagsOf = (settings: options): number => SQLITE_UTF8 | (settings.deterministic ? SQLITE_DETERMINISTIC : 0);

	const scalar = (name: string, callback: (...values: value[]) => unknown, settings: options = {}): void => {
		checkName(name);
		checkFunction(callback, "the callback");
		const bigint = settings.bigint ?? connection.bigint;
		register(name, settings.variadic ? -1 : callback.length, flagsOf(settings), SCALAR, {
			call(context, argc, argv) {
				try {
					setResult(instance, context, callback(...argumentValues(instance, argc, argv, bigint)));
				} catch (thrown) {
					report(context, thrown);
				}
			}
		});
	};

	const aggregate = (name: string, definition: aggregate): void => {
		checkName(name);
		const { start = null, step, inverse, result } = definition;
		checkFunction(step, "step");
		if (inverse !== undefined) checkFunction(inverse, "inverse");
		if (result !== undefined) checkFunction(result, "result");
		const bigint = definition.bigint ?? connection.bigint;
		// Accumulators by aggregate context pointer, which is unique per group while the group is being computed.
		const totals = new Map<number, { total: unknown }>();
		const fresh = (): unknown => (typeof start === "function" ? start() : start);
		const holder = (context: number): { total: unknown } => {
			const pointer = exports.sqlite3_aggregate_context(context, 4);
			let entry = totals.get(pointer);
			if (!entry) totals.set(pointer, (entry = { total: fresh() }));
			return entry;
		};
		const fold = (callback: (total: never, ...values: value[]) => unknown) => (context: number, argc: number, argv: number) => {
			try {
				const entry = holder(context);
				const next = callback(entry.total as never, ...argumentValues(instance, argc, argv, bigint));
				if (next !== undefined) entry.total = next;
			} catch (thrown) {
				report(context, thrown);
			}
		};
		const handler: CallbackHandler = {
			call: fold(step),
			final(context, final) {
				// A group with no rows never allocated a context (pointer 0): its accumulator is a fresh start value.
				const pointer = exports.sqlite3_aggregate_context(context, 0);
				try {
					const entry = totals.get(pointer);
					const total = entry ? entry.total : fresh();
					setResult(instance, context, result ? result(total as never) : total);
				} catch (thrown) {
					report(context, thrown);
				} finally {
					if (final) totals.delete(pointer);
				}
			}
		};
		if (inverse) handler.inverse = fold(inverse);
		const argc = definition.variadic ? -1 : Math.max(0, step.length - 1);
		register(name, argc, flagsOf(definition), inverse ? WINDOW : AGGREGATE, handler);
	};

	const collation = (name: string, compare: (a: string, b: string) => number): void => {
		checkName(name);
		checkFunction(compare, "compare");
		const db = handle(connection);
		const id = instance.callbacks.add({
			collate(length1, pointer1, length2, pointer2) {
				try {
					const order = Number(compare(memory.readUtf8(pointer1, length1), memory.readUtf8(pointer2, length2)));
					return order > 0 ? 1 : order < 0 ? -1 : 0;
				} catch (thrown) {
					// A collation can't report an error; the statement finishes and step() rethrows this.
					runtime.pending ??= { error: thrown };
					return 0;
				}
			}
		});
		const text = memory.allocCString(name);
		const rc = exports.cldmv_create_collation(db, text.pointer, id);
		memory.free(text.pointer);
		if (rc !== SQLITE_OK) throw failure(connection, rc);
	};

	return Object.freeze({ scalar, aggregate, agg: aggregate, collation });
}
