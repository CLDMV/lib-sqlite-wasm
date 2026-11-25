/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/registry.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:43:39-08:00 (1795599819)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Storage driver registry: maps a `storage` option to the module that implements it and loads that
 * module on first use.
 *
 * Each driver module exports one factory, `create(options)`, which returns a `VfsDriver` (or a promise of one, for
 * drivers that must open handles asynchronously, like OPFS). The factory runs once per database file the API opens:
 * for `sqlite.open()`, for `db.attach()` and for the target of `db.backup()`. A driver decides for itself what it
 * shares between those calls; the memory driver, for example, is one object per process so that reopening a name
 * finds its data again.
 *
 * Drivers are imported lazily (never at import time, and only the one asked for), so a browser bundle doesn't pull in
 * `node:fs` and the package can be loaded through require(esm).
 */
import { error } from "../api/error.mts";
import { SQLITE_CANTOPEN } from "../core/constants.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";
import { MemoryDriver } from "./memory.mts";

/** A concrete storage kind ("auto" resolves to one of these). */
export type StorageKind = "memory" | "fs" | "opfs";

/** What a driver factory is told about the file it is opened for. */
export interface DriverOptions {
	/** The database path as the caller passed it. */
	path: string;
	/** Opened read-only. */
	readonly: boolean;
	/** The file may be created. */
	create: boolean;
	/** Busy timeout in milliseconds. */
	timeout: number;
}

/**
 * A driver as a module's `create()` returns it. Drivers whose files must be made ready asynchronously before SQLite
 * touches them (OPFS: a Web Lock plus sync access handles for the database, -journal and -wal) add two hooks:
 *   - `prepare(path, { create })` runs before sqlite3_open_v2 / ATTACH and resolves to the name SQLite opens;
 *   - `release(name)` runs after sqlite3_close_v2 / DETACH (and when an open or attach fails after `prepare`). Close
 *     is synchronous, so a promise it returns is not awaited and its rejection is ignored.
 */
export interface StorageDriver extends VfsDriver {
	prepare?(path: string, options: { create: boolean }): Promise<string>;
	release?(name: string): unknown;
}

/** The shape of a driver module (src/vfs/<kind>.mts). */
export interface DriverModule {
	create(options: DriverOptions): StorageDriver | Promise<StorageDriver>;
}

let memory: MemoryDriver | undefined;

/** The process-wide memory driver; also the router's fallback for temporary files. */
export function sharedMemory(): MemoryDriver {
	memory ??= new MemoryDriver();
	return memory;
}

/** A loader for a driver this build doesn't include yet. */
function unavailable(kind: StorageKind): () => Promise<DriverModule> {
	return () => Promise.reject(new error(`storage "${kind}" is not available in this build`, SQLITE_CANTOPEN));
}

/**
 * Driver loaders. The node-fs and OPFS drivers are added by their own modules; each becomes
 * `() => import("./fs.mts")` / `() => import("./opfs.mts")` once that file exists.
 */
const loaders: Record<StorageKind, () => Promise<DriverModule>> = {
	memory: async () => ({ create: sharedMemory }),
	fs: unavailable("fs"),
	opfs: unavailable("opfs")
};

/**
 * Replaces the loader for `kind` and returns the previous one. Internal: tests use it to stand in drivers, and a phase
 * that adds a driver module can try it before the static import above is switched over.
 */
export function install(kind: StorageKind, loader: () => Promise<DriverModule>): () => Promise<DriverModule> {
	const previous = loaders[kind];
	loaders[kind] = loader;
	return previous;
}

/** The globals `detect()` looks at. */
export interface Environment {
	process?: { versions?: { node?: string } };
	FileSystemSyncAccessHandle?: unknown;
}

/** The storage "auto" means here: files in Node, OPFS in a browser worker, memory anywhere else. */
export function detect(scope: Environment = globalThis as Environment): StorageKind {
	if (typeof scope.process?.versions?.node === "string") return "fs";
	if (typeof scope.FileSystemSyncAccessHandle === "function") return "opfs";
	return "memory";
}

/** Whether `value` names a storage kind or "auto". */
export function isStorage(value: unknown): value is StorageKind | "auto" {
	return value === "auto" || (typeof value === "string" && Object.hasOwn(loaders, value));
}

/** Loads the driver module for `kind` and creates a driver for one database file. */
export async function load(kind: StorageKind, options: DriverOptions): Promise<StorageDriver> {
	const module = await loaders[kind]();
	return module.create(options);
}
