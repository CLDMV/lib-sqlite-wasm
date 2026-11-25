/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/database.mts
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
import { type fn } from "./functions.mts";
import { type storage } from "./open.mts";
import { statement } from "./statement.mts";
import { transaction } from "./transaction.mts";
import type { value } from "./values.mts";
/** Connection state behind each database object (internal: tests and the other API modules reach it here). */
export declare const connections: WeakMap<database, Connection>;
/** `db.pragma`. */
export interface pragma {
    /** The first value `PRAGMA name` returns, or undefined. */
    get(name: string): value | undefined;
    /** Runs `PRAGMA name = value` and returns the first value it returns, or undefined. */
    set(name: string, value: number | bigint | string | boolean): value | undefined;
    /** Every row `PRAGMA name` (or `PRAGMA name(argument)`) returns. */
    all(name: string, argument?: number | bigint | string | boolean): Record<string, value>[];
}
/** `db.info`. */
export interface info {
    /** The path the database was opened with. */
    readonly path: string;
    /** The storage driver it uses. */
    readonly storage: string;
    /**
     * The cross-process lock in effect: "beside", "temp", "db" or the folder given as `lock` (node-fs), "web" (OPFS
     * with Web Locks), "none" (memory). "beside" reads "temp" when it fell back.
     */
    readonly lock: string;
    /** Whether it is still open. */
    readonly open: boolean;
    /** Whether a transaction is open. */
    readonly transaction: boolean;
}
/** `db.checkpoint()`'s result, straight from `PRAGMA wal_checkpoint`. */
export interface checkpoint {
    /** 1 if the checkpoint couldn't finish because of a lock. */
    busy: number;
    /** Frames in the WAL (-1 when the database isn't in WAL mode). */
    log: number;
    /** Frames copied back into the database (-1 when not in WAL mode). */
    checkpointed: number;
}
/** Checkpoint modes. */
export type mode = "passive" | "full" | "restart" | "truncate";
/** An open database connection. */
export declare class database {
    #private;
    /** Reads and sets pragmas. */
    readonly pragma: pragma;
    /** Registers user-defined functions and collations. */
    readonly fn: fn;
    /** Path, storage and state. */
    readonly info: info;
    /** @internal Use `sqlite.open()`. */
    constructor(connection: Connection);
    /** Compiles one SQL statement. `bigint` overrides the database's option for this statement. */
    prepare(sql: string, options?: {
        bigint?: boolean;
    }): statement;
    /** Alias of `prepare`. */
    prep: (sql: string, options?: {
        bigint?: boolean;
    }) => statement;
    /** Runs one or more SQL statements, discarding any rows. */
    execute(sql: string): this;
    /** Alias of `execute`. */
    exec: (sql: string) => this;
    /** Wraps `callback` so each call runs in a transaction (a savepoint when nested). */
    transaction<parameters extends unknown[], output>(callback: (...parameters: parameters) => output): transaction<parameters, output>;
    /** Alias of `transaction`. */
    tx: database["transaction"];
    /** Attaches another database file as `schema`. Uses this database's storage unless `options.storage` says otherwise. */
    attach(path: string, schema: string, options?: {
        storage?: storage;
    }): Promise<void>;
    /** Detaches the database attached as `schema`. */
    detach(schema: string): Promise<void>;
    /**
     * Copies the database (or the attached `options.schema`) into the file `target` with SQLite's backup API, replacing
     * whatever the file held. The target uses this database's storage unless `options.storage` says otherwise.
     */
    backup(target: string, options?: {
        storage?: storage;
        schema?: string;
    }): Promise<void>;
    /** The database (or attached `schema`) as the bytes of an SQLite file. */
    serialize(schema?: string): Uint8Array;
    /** Runs a WAL checkpoint; `mode` defaults to "passive". */
    checkpoint(mode?: mode): checkpoint;
    /** Alias of `checkpoint`. */
    ckpt: (mode?: mode) => checkpoint;
    /** Finalizes every statement and closes the connection. A WAL database is checkpointed and its -wal file removed. Later calls do nothing. */
    close(): void;
}
