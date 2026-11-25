/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/statement.mts
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
import { type Connection, type StatementState } from "./connection.mts";
import { type value } from "./values.mts";
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
/** What the safety net needs to finalize a dropped statement. Never references the statement object itself. */
interface Held {
    connection: Connection;
    state: StatementState;
}
/** Finalizes a statement whose object was garbage collected while still prepared. */
export declare function collect({ connection, state }: Held): void;
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
export declare class statement {
    #private;
    /** Rows as positional arrays. */
    readonly raw: raw;
    /** The first column of each row. */
    readonly pluck: pluck;
    /** Rows grouped by source table. */
    readonly expand: expand;
    /** SQL text and kind. */
    readonly info: info;
    /** @internal Use `db.prepare()`. */
    constructor(connection: Connection, pointer: number, bigint: boolean);
    /** Executes the statement and returns how many rows it changed and the last inserted rowid. */
    run(...parameters: unknown[]): result;
    /** The first row as an object, or undefined. */
    get(...parameters: unknown[]): row | undefined;
    /** Every row as an object. */
    all(...parameters: unknown[]): row[];
    /** An iterator over the rows as objects. The statement can't run again until the iterator finishes or is returned. */
    iterate(...parameters: unknown[]): IterableIterator<row>;
    /** Alias of `iterate`. */
    iter: (...parameters: unknown[]) => IterableIterator<row>;
    /** Binds `parameters` for every later execution, which must then pass none. Can be called once. */
    bind(...parameters: unknown[]): this;
    /** Describes the result columns. */
    columns(): column[];
    /** Alias of `columns`. */
    cols: () => column[];
    /** Finalizes the statement. Later calls do nothing. */
    close(): void;
}
export {};
