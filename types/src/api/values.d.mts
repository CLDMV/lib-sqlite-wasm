/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/values.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599820)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:43:39-08:00 (1795599820)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import type { SqliteInstance } from "../core/loader.mts";
/** A value SQLite stores. */
export type value = null | number | bigint | string | Uint8Array;
/** Converts an INTEGER read from SQLite. */
export declare function integer(raw: bigint, bigint: boolean): number | bigint;
/** Binds `input` to parameter `index` (1-based) of `stmt`; returns SQLite's result code. */
export declare function bindValue(instance: SqliteInstance, stmt: number, index: number, input: unknown): number;
/** Sets `input` as the result of the user function call `context`. */
export declare function setResult(instance: SqliteInstance, context: number, input: unknown): void;
/**
 * Binds `parameters` to every parameter of `stmt`. Arguments are positional values, arrays of positional values, or
 * one plain object of named values (keys without the `:`, `@` or `$` prefix). Anonymous parameters (`?`, `?NNN`) take
 * the positional values in order. Every parameter must get a value and every positional value must be used.
 * Returns SQLite's result code from the first bind that failed, or SQLITE_OK.
 */
export declare function bindAll(instance: SqliteInstance, stmt: number, parameters: readonly unknown[]): number;
/** Column `index` of the current row of `stmt`. */
export declare function columnValue(instance: SqliteInstance, stmt: number, index: number, bigint: boolean): value;
/** The `argc` arguments at `argv` of a user function call. */
export declare function argumentValues(instance: SqliteInstance, argc: number, argv: number, bigint: boolean): value[];
