/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/drizzle.mts
 *	@Date: 2026-11-25T03:10:00-08:00 (1795605000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T03:10:00-08:00 (1795605000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import { type Logger } from "drizzle-orm/logger";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { database } from "./api/database.mts";
import type { database as client } from "./worker/client.mts";
/** Drizzle's options. `cache` isn't supported. */
export interface config<schema extends Record<string, unknown> = Record<string, never>> {
    /** `true` logs every query to the console; or pass a logger. */
    logger?: boolean | Logger;
    /** The tables and relations (`import * as schema from "./schema"`), which enables `db.query.*`. */
    schema?: schema;
    /** Column name casing, as in Drizzle's own config. */
    casing?: "snake_case" | "camelCase";
}
/** What a statement's `run()` resolves to under Drizzle (better-sqlite3's shape, which Drizzle's types use). */
export interface outcome {
    changes: number;
    lastInsertRowid: number | bigint;
}
/** A Drizzle database over a synchronous sqlite-wasm database. */
export type local<schema extends Record<string, unknown> = Record<string, never>> = BaseSQLiteDatabase<"sync", outcome, schema> & {
    $client: database;
};
/** A Drizzle database over a worker client. `batch()` runs its queries in one transaction in the worker. */
export type remote<schema extends Record<string, unknown> = Record<string, never>> = SqliteRemoteDatabase<schema> & {
    $client: client;
};
/** Migrations as data: `meta/_journal.json` and the SQL files, keyed `m0000`, `m0001`, ... */
export interface migrations {
    journal: {
        entries: {
            idx: number;
            when: number;
            tag: string;
            breakpoints: boolean;
        }[];
    };
    migrations: Record<string, string>;
}
/**
 * Wraps `db` for Drizzle. A database from `sqlite.open()` gives a synchronous Drizzle database; a client from
 * `@cldmv/sqlite-wasm/worker` gives an asynchronous one. Drizzle's own `sqlite-proxy` also works against
 * `client.proxy` directly (`drizzle-orm/sqlite-proxy`'s `drizzle(db.proxy)`), without the batch and transaction wiring.
 */
export declare function drizzle<schema extends Record<string, unknown> = Record<string, never>>(db: database, config?: config<schema>): local<schema>;
export declare function drizzle<schema extends Record<string, unknown> = Record<string, never>>(db: client, config?: config<schema>): remote<schema>;
/** Applies bundled `migrations` that haven't run yet, in one transaction. Returns a promise for a worker client. */
export declare function migrate<schema extends Record<string, unknown>>(db: local<schema>, config: migrations): void;
export declare function migrate<schema extends Record<string, unknown>>(db: remote<schema>, config: migrations): Promise<void>;
