/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/wasi.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
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
 * @fileoverview The wasi_snapshot_preview1 functions wasi-libc still references from sqlite3.wasm.
 *
 * SQLite itself runs with SQLITE_OS_OTHER and never touches the OS: files, time and sleeping go through the VFS
 * imports. What is left is libc's own use of WASI, which in the current build is a single function, `random_get`.
 * The loader rejects a module that imports anything not listed here, so a toolchain or libc change that adds a WASI
 * dependency fails loudly at load time and gets a shim added here deliberately.
 */
import type { WasmMemory } from "./memory.mts";
/** The import module name wasi-sdk's wasm32-wasip1 target uses. */
export declare const WASI_MODULE = "wasi_snapshot_preview1";
/** Builds the WASI shims for one module instance. `memory` is read lazily (it exists only after instantiation). */
export declare function createWasiImports(memory: () => WasmMemory | undefined): Record<string, (...args: never[]) => number>;
