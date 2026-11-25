/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/callbacks.mts
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
 * @fileoverview The JS side of glue.c's callback trampolines: the `env.cb_*` imports and the id -> handler table
 * they dispatch through.
 *
 * glue.c registers every user function and collation with a fixed C trampoline and a numeric id as its user-data
 * pointer. The trampoline calls one of these imports with that id; the table finds the handler. Handlers must not
 * throw: an exception unwinding through wasm frames would leave SQLite in an undefined state, so the API layer catches
 * inside each handler and reports the failure through SQLite.
 */
/** What one registered id can be called for. A function uses `call` / `final` / `inverse`, a collation `collate`. */
export interface CallbackHandler {
    /** Scalar call, aggregate step or window step. */
    call?(context: number, argc: number, argv: number): void;
    /** Aggregate final (`final` true) or window value (`final` false). */
    final?(context: number, final: boolean): void;
    /** Window inverse step. */
    inverse?(context: number, argc: number, argv: number): void;
    /** Collation compare of two UTF-8 strings given as (length, pointer) pairs. */
    collate?(length1: number, pointer1: number, length2: number, pointer2: number): number;
}
/** The id -> handler table of one module instance. */
export declare class CallbackTable {
    #private;
    /** Registers `handler` and returns its id. */
    add(handler: CallbackHandler): number;
    /** The handler for `id`. */
    get(id: number): CallbackHandler;
    /** Number of registered handlers. */
    get size(): number;
    /** Forgets `id` (SQLite dropped the function or collation). */
    delete(id: number): void;
}
/** Builds the `env.cb_*` imports for one module instance. */
export declare function createCallbackImports(table: CallbackTable): Record<string, (...args: number[]) => number | void>;
