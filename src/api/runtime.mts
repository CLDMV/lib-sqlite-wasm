/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/api/runtime.mts
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
 * @fileoverview The process-wide SQLite instance every connection runs in.
 *
 * All connections share one module instance, created on the first `sqlite.open()` and cached. Reasons:
 *   - `db.backup()` and `ATTACH` work between connections only when both live in the same SQLite library instance
 *     (sqlite3_backup_init takes two sqlite3 handles).
 *   - Each instance has its own linear memory (megabytes once SQLite's page cache warms up) and its own copy of
 *     SQLite's globals; one per connection multiplies that for nothing.
 *   - The build is single-threaded (SQLITE_THREADSAFE=0) and so is JS, so connections never run concurrently.
 * The cost is that one instance's memory only grows, and a trap inside the module would take every connection down.
 * Storage still differs per connection: the instance's single VFS is a router that sends each database's files to
 * the driver it was opened with.
 */
import { instantiateSqlite, loadSqliteModule, type SqliteInstance } from "../core/loader.mts";
import { VfsRouter } from "../core/router.mts";
import { sharedMemory } from "../vfs/registry.mts";

/** The shared instance and its state. */
export interface Runtime {
	readonly instance: SqliteInstance;
	readonly router: VfsRouter;
	/** An exception a user function or collation threw; rethrown when the statement that ran it returns. */
	pending: { error: unknown } | undefined;
}

let shared: Promise<Runtime> | undefined;

/** The process-wide runtime, created on first use. */
export function runtime(): Promise<Runtime> {
	shared ??= loadSqliteModule().then(async (module) => {
		const router = new VfsRouter(sharedMemory());
		const instance = await instantiateSqlite(module, router);
		return { instance, router, pending: undefined };
	});
	return shared;
}
