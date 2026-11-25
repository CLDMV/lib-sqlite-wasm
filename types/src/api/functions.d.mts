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
import { type Connection } from "./connection.mts";
import { type value } from "./values.mts";
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
/** Builds the `db.fn` namespace for `connection`. */
export declare function functions(connection: Connection): fn;
