/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/transaction.mts
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
 * @fileoverview `db.transaction(callback)`: wraps a function so each call runs inside a transaction.
 *
 * The wrapper begins a transaction, calls the callback, and commits; if the callback throws, it rolls back and
 * rethrows. Called while a transaction is already open (from inside another transaction function, or after a manual
 * BEGIN), it uses a savepoint instead, so nested calls roll back only their own part. The callback must be
 * synchronous: a returned promise rolls the transaction back and throws, because the commit would otherwise run
 * before the awaited work.
 */
import { type Connection, execute, inTransaction } from "./connection.mts";

/** A function wrapped by `db.transaction()`. Calling it uses BEGIN (deferred); the properties pick the mode. */
export interface transaction<parameters extends unknown[], output> {
	(...parameters: parameters): output;
	/** BEGIN DEFERRED. */
	deferred(...parameters: parameters): output;
	/** BEGIN IMMEDIATE: takes the write lock up front. */
	immediate(...parameters: parameters): output;
	/** BEGIN EXCLUSIVE. */
	exclusive(...parameters: parameters): output;
}

/** The savepoint used for nested calls; SQLite releases the most recent one of a name, so one name serves every level. */
const SAVEPOINT = "sqlite_wasm_tx";

/** Rolls back what `run()` began, unless SQLite already did (or the callback closed the database). */
function undo(connection: Connection, nested: boolean): void {
	if (!inTransaction(connection)) return;
	execute(connection, nested ? `ROLLBACK TO ${SAVEPOINT}; RELEASE ${SAVEPOINT}` : "ROLLBACK");
}

/** Runs `callback` inside a transaction started with `begin` (or a savepoint when one is already open). */
function run<parameters extends unknown[], output>(
	connection: Connection,
	begin: string,
	callback: (...parameters: parameters) => output,
	self: unknown,
	parameters: parameters
): output {
	const nested = inTransaction(connection);
	execute(connection, nested ? `SAVEPOINT ${SAVEPOINT}` : begin);
	let output: output;
	try {
		output = callback.apply(self, parameters);
		if (typeof (output as { then?: unknown } | null)?.then === "function") {
			throw new TypeError("sqlite-wasm: a transaction callback must not return a promise");
		}
	} catch (thrown) {
		undo(connection, nested);
		throw thrown;
	}
	try {
		execute(connection, nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
	} catch (thrown) {
		undo(connection, nested);
		throw thrown;
	}
	return output;
}

/** Wraps `callback` for `connection`. */
export function transaction<parameters extends unknown[], output>(
	connection: Connection,
	callback: (...parameters: parameters) => output
): transaction<parameters, output> {
	if (typeof callback !== "function") throw new TypeError("sqlite-wasm: transaction() needs a function");
	const mode = (begin: string) =>
		function (this: unknown, ...parameters: parameters): output {
			return run(connection, begin, callback, this, parameters);
		};
	return Object.assign(mode("BEGIN"), {
		deferred: mode("BEGIN DEFERRED"),
		immediate: mode("BEGIN IMMEDIATE"),
		exclusive: mode("BEGIN EXCLUSIVE")
	});
}
