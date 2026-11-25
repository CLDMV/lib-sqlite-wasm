/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/index.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T00:57:11-08:00 (1795597031)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@cldmv/sqlite-wasm";

describe("package entry", () => {
	it("exports the package name from the ESM entry", () => {
		expect(PACKAGE_NAME).toBe("@cldmv/sqlite-wasm");
	});
});
