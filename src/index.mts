/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/index.mts
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:39:09-08:00 (1795603149)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Package entry: `sqlite.open()` and `sqlite.error`.
 *
 * ```js
 * import sqlite from "@cldmv/sqlite-wasm";
 * const db = await sqlite.open("app.sqlite3", { storage: "memory" });
 * db.prepare("select ? as answer").get(42); // { answer: 42 }
 * ```
 *
 * Nothing runs at import time: the wasm module is compiled and instantiated by the first `open()`, so this entry can
 * also be loaded through the CommonJS wrapper (require(esm) cannot wait for top-level await).
 */
import { error } from "./api/error.mts";
import { open } from "./api/open.mts";

/** The package's API. */
export interface sqlite {
	/** Opens a database. */
	readonly open: typeof open;
	/** The class of every error SQLite reports. */
	readonly error: typeof error;
	/** Alias of `error`. */
	readonly err: typeof error;
}

const sqlite: sqlite = Object.freeze({ open, error, err: error });

export default sqlite;
export { open, error, error as err };
export type { database, pragma, info, checkpoint, mode } from "./api/database.mts";
export type { statement, row, result, column } from "./api/statement.mts";
export type { options, storage, journal, sync } from "./api/open.mts";
export type { fn, aggregate } from "./api/functions.mts";
export type { transaction } from "./api/transaction.mts";
export type { value } from "./api/values.mts";
