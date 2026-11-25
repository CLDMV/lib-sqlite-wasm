/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/platform.mts
 *	@Date: 2026-11-25T09:00:00-08:00 (1795626000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T09:00:00-08:00 (1795626000)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * @fileoverview What only Node can do: read a file from disk, the node-fs storage driver, and the host name and pid
 * check behind the "db" lock. `src/node.mts` provides them, and only the Node entry imports it.
 *
 * The modules here are shared by every entry (the Node API, the worker host, the worker client, Drizzle), and the
 * build puts each of them in one chunk that all entries import. A `node:` import anywhere in them would end up in the
 * browser entries' graph too, so they reach Node through this module instead.
 */
import type { DriverModule } from "../vfs/registry.mts";
/** The Node-only capabilities. */
export interface platform {
    /** Reads a whole file. */
    read(url: URL): Promise<Uint8Array>;
    /** The node-fs storage driver module. */
    fs(): Promise<DriverModule>;
    /** This host's name and a liveness check for a pid on it. */
    processes(): Promise<{
        host: string;
        alive(pid: number): boolean;
    }>;
}
/** Sets the Node capabilities (`undefined` removes them) and returns the previous ones. */
export declare function provide(next: platform | undefined): platform | undefined;
/** The Node capabilities, or an error naming `what` needed them. */
export declare function node(what: string): platform;
