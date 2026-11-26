/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/api/error.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:11-08:00 (1795642211)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview `sqlite.error`: the error thrown for anything SQLite reports as a failure.
 */
import { codeName } from "../core/codes.mts";

/** An SQLite failure: `code` is the result code's name, `number` the extended result code, `sql` the statement. */
export class error extends Error {
	/** The extended result code's name, e.g. "SQLITE_CONSTRAINT_UNIQUE". */
	readonly code: string;
	/** The extended result code, e.g. 2067. */
	readonly number: number;
	/** The SQL that failed, when the failure came from a statement. */
	readonly sql: string | undefined;

	constructor(message: string, number: number, sql?: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "sqlite.error";
		this.code = codeName(number);
		this.number = number;
		this.sql = sql;
	}
}
