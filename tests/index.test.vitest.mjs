/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/index.test.vitest.mjs
 *	@Date: 2026-11-25T00:47:55-08:00 (1795596475)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T00:48:03-08:00 (1795596483)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@cldmv/sqlite-wasm";

const require = createRequire(import.meta.url);

describe("package entry", () => {
	it("exports the package name from the ESM entry", () => {
		expect(PACKAGE_NAME).toBe("@cldmv/sqlite-wasm");
	});

	it("exposes the same export through the CJS shim", () => {
		const cjs = require("../src/index.cjs");
		expect(cjs.PACKAGE_NAME).toBe("@cldmv/sqlite-wasm");
		expect(Object.keys(cjs)).toEqual(["PACKAGE_NAME"]);
	});
});
