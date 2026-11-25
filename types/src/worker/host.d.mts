/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/host.mts
 *	@Date: 2026-11-25T02:10:00-08:00 (1795601400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T02:10:00-08:00 (1795601400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
import { type source } from "../core/browser-loader.mts";
import type { database } from "../api/database.mts";
import type { options as opfsoptions } from "../vfs/opfs.mts";
import { type engine } from "./engine.mts";
import { type endpoint, type settings } from "./protocol.mts";
/** Options for `listen()`: where the wasm comes from, the OPFS driver's options, and a hook run after open. */
export interface options extends Omit<opfsoptions, "timeout"> {
    /** sqlite3.wasm as a URL, bytes, a Response or a compiled module; the package's own file when omitted. */
    wasm?: source;
    /** Runs after each open with the database (register functions and collations here); a throw fails the open. */
    setup?: (db: database) => unknown;
}
/** What the host depends on; `listen()` fills it in, tests swap parts out. */
export interface dependencies {
    connect(path: string, settings: settings): Promise<engine>;
    setup?: (db: database) => unknown;
    /**
     * Takes the Web Lock `name` for the rest of the worker's life; resolves to whether it could (false without Web
     * Locks). A shared connection's leader tab waits on the same lock to learn that its worker is gone.
     */
    hold?: (name: string) => Promise<boolean>;
}
/** Answers requests arriving on `scope`. Returns a function that stops listening (the database stays as it is). */
export declare function serve(scope: endpoint, dependencies: dependencies): () => void;
/**
 * Starts answering the client. Call it once at the top of the worker file.
 * @param scope    where requests arrive; the worker's global scope by default
 * @param options  the wasm location, the OPFS driver's options, and the `setup(db)` hook
 */
export declare function listen(scope?: endpoint, options?: options): () => void;
/** The host as a namespace: `host.listen()`. */
declare const host: {
    listen: typeof listen;
};
export default host;
