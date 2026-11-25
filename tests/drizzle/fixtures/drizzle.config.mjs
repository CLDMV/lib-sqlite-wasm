/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/drizzle/fixtures/drizzle.config.mjs
 *	@Date: 2026-11-25T03:20:00-08:00 (1795605600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T03:20:00-08:00 (1795605600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/** @fileoverview drizzle-kit config for the test schema (`npm run drizzle:generate`). */
export default {
	dialect: "sqlite",
	schema: "./tests/drizzle/fixtures/schema.mjs",
	out: "./tests/drizzle/fixtures/migrations"
};
