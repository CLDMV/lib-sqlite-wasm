/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/drizzle/fixtures/data.mjs
 *	@Date: 2026-11-25T03:30:00-08:00 (1795606200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T03:30:00-08:00 (1795606200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/** @fileoverview The drizzle-kit migrations in ./migrations as bundled data (`{ journal, migrations }`), for Node tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The migrations folder, for Drizzle's folder-based migrators. */
export const folder = fileURLToPath(new URL("./migrations", import.meta.url));

const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8"));

/** The same migrations as data. */
export const bundled = {
	journal,
	migrations: Object.fromEntries(
		journal.entries.map((entry) => [`m${String(entry.idx).padStart(4, "0")}`, readFileSync(`${folder}/${entry.tag}.sql`, "utf8")])
	)
};
