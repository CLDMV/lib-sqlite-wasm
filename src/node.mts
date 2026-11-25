/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/node.mts
 *	@Date: 2026-11-25T09:00:00-08:00 (1795626000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:13-08:00 (1795642213)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The Node-only capabilities the shared code needs (see core/platform.mts). The Node entry passes them to
 * `provide()`; the browser entries never import this module, so no `node:` module is in their graph. The `node:`
 * modules are imported when first used.
 *
 * It is an export rather than a side effect on import: the package declares `"sideEffects": false`, so a bundler may
 * drop a module that is only imported for its side effects.
 */
import type { platform } from "./core/platform.mts";

export const capabilities: platform = {
	read: async (url) => (await import("node:fs/promises")).readFile(url),
	fs: () => import("./vfs/fs.mts"),
	async processes() {
		const os = await import("node:os");
		return {
			host: os.hostname(),
			alive(pid: number): boolean {
				try {
					process.kill(pid, 0);
					return true;
				} catch (thrown) {
					// EPERM: the process exists but belongs to another user.
					return (thrown as NodeJS.ErrnoException).code === "EPERM";
				}
			}
		};
	}
};
