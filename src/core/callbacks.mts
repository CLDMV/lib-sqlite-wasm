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
export class CallbackTable {
	#next = 1;
	readonly #handlers = new Map<number, CallbackHandler>();

	/** Registers `handler` and returns its id. */
	add(handler: CallbackHandler): number {
		const id = this.#next++;
		this.#handlers.set(id, handler);
		return id;
	}

	/** The handler for `id`. */
	get(id: number): CallbackHandler {
		return this.#handlers.get(id) as CallbackHandler;
	}

	/** Number of registered handlers. */
	get size(): number {
		return this.#handlers.size;
	}

	/** Forgets `id` (SQLite dropped the function or collation). */
	delete(id: number): void {
		this.#handlers.delete(id);
	}
}

/** Builds the `env.cb_*` imports for one module instance. */
export function createCallbackImports(table: CallbackTable): Record<string, (...args: number[]) => number | void> {
	type Handler = Required<CallbackHandler>;
	return {
		cb_func: (id, context, argc, argv) => (table.get(id) as Handler).call(context, argc, argv),
		cb_final: (id, context, final) => (table.get(id) as Handler).final(context, final !== 0),
		cb_inverse: (id, context, argc, argv) => (table.get(id) as Handler).inverse(context, argc, argv),
		cb_destroy: (id) => table.delete(id),
		cb_collate: (id, length1, pointer1, length2, pointer2) => (table.get(id) as Handler).collate(length1, pointer1, length2, pointer2)
	};
}
