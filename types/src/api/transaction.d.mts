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
import { type Connection } from "./connection.mts";
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
/** Wraps `callback` for `connection`. */
export declare function transaction<parameters extends unknown[], output>(connection: Connection, callback: (...parameters: parameters) => output): transaction<parameters, output>;
