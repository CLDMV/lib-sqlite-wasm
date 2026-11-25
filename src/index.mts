/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/index.mts
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:15-08:00 (1795598295)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Name of this package. Placeholder export while the public API is under design.
 */
export const PACKAGE_NAME: string = "@cldmv/sqlite-wasm";

/**
 * Low-level spike helpers: open a database on a VFS driver and run SQL. Internal and temporary; the public Database
 * API replaces them.
 * @internal
 */
export { openRaw, RawSqliteError } from "./core/raw.mts";
/** @internal */
export { MemoryDriver } from "./vfs/memory.mts";
