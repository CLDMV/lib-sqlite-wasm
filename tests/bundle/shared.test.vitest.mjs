/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/bundle/shared.test.vitest.mjs
 *	@Date: 2026-11-25T09:00:00-08:00 (1795626000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T19:16:36-08:00 (1795662996)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The entries share their modules instead of bundling a copy each: an error from the worker client is an instance of
 * the class the main entry exports. Under `npm run test:dist` the package names resolve to dist/, where this only
 * holds because each module is built once and the entries import it; in the normal run they resolve to src/.
 */
import sqlite from "@cldmv/sqlite-wasm";
import host from "@cldmv/sqlite-wasm/host";
import client from "@cldmv/sqlite-wasm/worker";
import { describe, expect, it } from "vitest";

describe("entries share one copy of their modules", () => {
	it("exports the same error class from the main entry and the worker client", () => {
		expect(client.error).toBe(sqlite.error);
		expect(client.err).toBe(sqlite.err);
	});

	it("rejects a worker client call with an instance of sqlite.error", async () => {
		const { port1, port2 } = new MessageChannel();
		host.listen(port2);
		const db = await client.connect(port1, "shared.db", { storage: "memory" });
		const failure = await db
			.prepare("select * from missing")
			.all()
			.catch((thrown) => thrown);
		expect(failure).toBeInstanceOf(sqlite.error);
		expect(failure).toBeInstanceOf(client.error);
		expect(failure).toMatchObject({ code: "SQLITE_ERROR" });
		await db.close();
		port1.close();
		port2.close();
	});
});
