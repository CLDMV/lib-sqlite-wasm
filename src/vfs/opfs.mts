/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/opfs.mts
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

/**
 * @fileoverview OPFS storage driver for browser workers.
 *
 * `FileSystemSyncAccessHandle` is synchronous, which is what the VFS needs, but it can only be obtained
 * asynchronously and only one handle per file may exist at a time. So there is no pool of anonymous handles: before
 * `sqlite3_open_v2` the caller awaits `prepare(path)`, which takes a Web Lock for the database and opens handles for
 * the database, its `-journal` and its `-wal`. SQLite then works on those handles synchronously. `release(path)`, after
 * the connection is closed, closes them, removes empty companion files and drops the lock.
 *
 * Every other file SQLite opens (temp databases, statement and super journals) lives in memory: the build uses
 * SQLITE_TEMP_STORE=3, so these are short-lived scratch files that don't need to persist.
 *
 * A companion file only "exists" for SQLite when it has content. `prepare()` has to create the `-journal` and `-wal`
 * files to get handles on them, and an empty `-wal` reported as existing would make SQLite switch a rollback-mode
 * database to WAL. Deleting a companion truncates it instead of removing it, since its handle stays open.
 */
import {
	SQLITE_IOERR_SHORT_READ,
	SQLITE_IOERR_WRITE,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_MAIN_DB,
	SQLITE_OPEN_MAIN_JOURNAL,
	SQLITE_OPEN_WAL
} from "../core/constants.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";
import { MemoryDriver } from "./memory.mts";

/** SQLITE_BUSY: what a database held by another tab reports. */
const BUSY = 5;
/** The file can't be deleted while it is open (true for OPFS: a file with an open sync handle can't be removed). */
const SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN = 0x00000800;
/** Files a database needs on disk, as suffixes of its name. */
const SUFFIXES = ["", "-journal", "-wal"] as const;
/** Prefix of the Web Lock names, so they don't clash with an application's own locks. */
const LOCK_PREFIX = "sqlite-wasm:";

/** The subset of `FileSystemSyncAccessHandle` the driver uses. */
export interface handle {
	read(buffer: Uint8Array, options: { at: number }): number;
	write(buffer: Uint8Array, options: { at: number }): number;
	truncate(size: number): void;
	getSize(): number;
	flush(): void;
	close(): void;
}

/** The subset of `FileSystemFileHandle` the driver uses. */
export interface file {
	createSyncAccessHandle(): Promise<handle>;
}

/** The subset of `FileSystemDirectoryHandle` the driver uses. */
export interface directory {
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<directory>;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<file>;
	removeEntry(name: string): Promise<void>;
}

/** The subset of the Web Locks `LockManager` the driver uses. */
export interface locks {
	request(
		name: string,
		options: { ifAvailable?: boolean; signal?: AbortSignal },
		callback: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
}

/** Options for `create()`. */
export interface options {
	/** The directory databases live in; `navigator.storage.getDirectory()` when omitted. */
	root?: directory | Promise<directory>;
	/** The Web Locks manager; `navigator.locks` when omitted. Pass `null` to rely on the exclusive sync handles alone. */
	locks?: locks | null;
	/**
	 * How long `prepare()` waits, in milliseconds, for another tab to close the database. `0` (the default) fails at
	 * once, `Infinity` waits for as long as it takes.
	 */
	wait?: number;
}

/** Options for `prepare()`. */
export interface preparation {
	/** Create the database file when it doesn't exist (default true). */
	create?: boolean;
}

/** The OPFS driver: a VFS driver plus the asynchronous steps around opening and closing a database. */
export interface driver extends VfsDriver {
	/**
	 * Takes the database's lock and opens its files. Await it before `sqlite3_open_v2`, and pass the returned name to
	 * it: SQLite derives the journal and WAL names from that exact string.
	 */
	prepare(path: string, options?: preparation): Promise<string>;
	/** Closes what `prepare()` opened and drops the lock. Call it after the connection is closed. */
	release(path: string): Promise<void>;
}

/** A file SQLite sees as persistent, backed by an open sync access handle. */
interface entry {
	access: handle;
}

/** A database `prepare()` has opened. */
interface database {
	folder: directory;
	base: string;
	files: Map<string, handle>;
	unlock: () => void;
}

/** An error that carries an SQLite code, so it reads like any other SQLite error after crossing a worker boundary. */
function failure(message: string, number: number, code: string, cause?: unknown): Error {
	return Object.assign(new Error(`sqlite-wasm: ${message}`, cause === undefined ? undefined : { cause }), { code, number });
}

/** The error for a database another tab (or another worker) holds. */
function busy(name: string, cause?: unknown): Error {
	return failure(`database "${name}" is open in another tab`, BUSY, "SQLITE_BUSY", cause);
}

/**
 * Turns a path into the canonical name SQLite uses for it: `/`-separated, with a leading `/`, no empty or `.`
 * segments. `..` is refused since OPFS has no parent of the root.
 */
export function normalize(path: string): string {
	const parts = path.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.length === 0 || parts.includes("..")) throw failure(`invalid OPFS path "${path}"`, 14, "SQLITE_CANTOPEN");
	return `/${parts.join("/")}`;
}

/** The ambient `navigator`, when there is one (browser windows and workers). */
function ambient(): { storage?: { getDirectory(): Promise<directory> }; locks?: locks } | undefined {
	return (globalThis as unknown as { navigator?: ReturnType<typeof ambient> }).navigator;
}

/** Creates an OPFS driver. One driver can serve any number of databases; each database is opened by one connection. */
export function create(options: options = {}): driver {
	const memory = new MemoryDriver();
	const lockmanager = options.locks === undefined ? ambient()?.locks : options.locks;
	const wait = options.wait ?? 0;
	let root: Promise<directory> | undefined;
	/** Persistent files by canonical name. */
	const entries = new Map<string, entry>();
	/** Prepared databases by canonical name. */
	const databases = new Map<string, database>();
	/** Releases still in progress, so a quick reopen waits for the previous lock to go. */
	const releasing = new Map<string, Promise<void>>();
	/** Open file ids backed by a persistent entry; every other id belongs to the memory driver. */
	const opened = new Map<number, entry>();

	const directoryroot = (): Promise<directory> => {
		root ??= Promise.resolve(options.root ?? (ambient()?.storage?.getDirectory() as Promise<directory>)).then((found) => {
			if (!found) throw failure("OPFS is not available here (no navigator.storage.getDirectory)", 14, "SQLITE_CANTOPEN");
			return found;
		});
		return root;
	};

	/** Takes the database's Web Lock; resolves to the function that drops it. */
	const acquire = (name: string): Promise<() => void> => {
		if (!lockmanager) return Promise.resolve(() => {});
		return new Promise((resolve, reject) => {
			let unlock!: () => void;
			const held = new Promise<void>((done) => {
				unlock = done;
			});
			const settings = wait === 0 ? { ifAvailable: true } : Number.isFinite(wait) ? { signal: AbortSignal.timeout(wait) } : {};
			lockmanager
				.request(LOCK_PREFIX + name, settings, (lock) => {
					if (lock === null) {
						reject(busy(name));
						return;
					}
					resolve(unlock);
					return held;
				})
				.catch((error: unknown) => reject(busy(name, error)));
		});
	};

	const close = (files: Map<string, handle>): void => {
		for (const [name, access] of files) {
			access.close();
			entries.delete(name);
		}
	};

	const persistent = (fileId: number): entry | undefined => opened.get(fileId);

	return {
		async prepare(path: string, settings: preparation = {}): Promise<string> {
			const name = normalize(path);
			await releasing.get(name);
			if (databases.has(name)) throw busy(name);
			const unlock = await acquire(name);
			const files = new Map<string, handle>();
			try {
				const segments = name.slice(1).split("/");
				const base = segments.pop() as string;
				let folder = await directoryroot();
				for (const segment of segments) folder = await folder.getDirectoryHandle(segment, { create: true });
				for (const suffix of SUFFIXES) {
					const create = suffix !== "" || settings.create !== false;
					let found: file;
					try {
						found = await folder.getFileHandle(base + suffix, { create });
					} catch (error) {
						if ((error as { name?: string }).name === "NotFoundError")
							throw failure(`database "${name}" does not exist`, 14, "SQLITE_CANTOPEN", error);
						throw error;
					}
					try {
						files.set(name + suffix, await found.createSyncAccessHandle());
					} catch (error) {
						// Another context holds a handle on the file without (or before) taking the Web Lock.
						if ((error as { name?: string }).name === "NoModificationAllowedError") throw busy(name, error);
						throw error;
					}
				}
				databases.set(name, { folder, base, files, unlock });
				for (const [file, access] of files) entries.set(file, { access });
				return name;
			} catch (error) {
				close(files);
				unlock();
				throw error;
			}
		},

		release(path: string): Promise<void> {
			const name = normalize(path);
			const prepared = databases.get(name);
			if (!prepared) return releasing.get(name) ?? Promise.resolve();
			databases.delete(name);
			const empty = SUFFIXES.slice(1).filter((suffix) => (prepared.files.get(name + suffix) as handle).getSize() === 0);
			close(prepared.files);
			const done = (async () => {
				try {
					for (const suffix of empty) {
						try {
							await prepared.folder.removeEntry(prepared.base + suffix);
						} catch {
							// Leaving an empty companion behind is harmless: it reads as absent on the next open.
						}
					}
				} finally {
					prepared.unlock();
					releasing.delete(name);
				}
			})();
			releasing.set(name, done);
			return done;
		},

		open(name: string | null, fileId: number, flags: number): number {
			const found = name === null ? undefined : entries.get(name);
			if (found) {
				opened.set(fileId, found);
				return SQLITE_OK;
			}
			if (flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_WAL)) {
				throw failure(`"${name}" was not prepared; await prepare() on the database before opening it`, 14, "SQLITE_CANTOPEN");
			}
			return memory.open(name, fileId, flags | SQLITE_OPEN_CREATE);
		},

		delete(name: string, syncDir: boolean): number {
			const found = entries.get(name);
			if (!found) return memory.delete(name);
			found.access.truncate(0);
			if (syncDir) found.access.flush();
			return SQLITE_OK;
		},

		access(name: string): boolean {
			const found = entries.get(name);
			return found ? found.access.getSize() > 0 : memory.access(name);
		},

		fullPathname(name: string): string {
			return normalize(name);
		},

		read(fileId: number, target: Uint8Array, offset: number): number {
			const found = persistent(fileId);
			if (!found) return memory.read(fileId, target, offset);
			const count = found.access.read(target, { at: offset });
			if (count === target.length) return SQLITE_OK;
			target.fill(0, count);
			return SQLITE_IOERR_SHORT_READ;
		},

		write(fileId: number, data: Uint8Array, offset: number): number {
			const found = persistent(fileId);
			if (!found) return memory.write(fileId, data, offset);
			return found.access.write(data, { at: offset }) === data.length ? SQLITE_OK : SQLITE_IOERR_WRITE;
		},

		truncate(fileId: number, size: number): number {
			const found = persistent(fileId);
			if (!found) return memory.truncate(fileId, size);
			found.access.truncate(size);
			return SQLITE_OK;
		},

		sync(fileId: number): number {
			persistent(fileId)?.access.flush();
			return SQLITE_OK;
		},

		size(fileId: number): number {
			const found = persistent(fileId);
			return found ? found.access.getSize() : memory.size(fileId);
		},

		// prepare() lets a database be opened by one connection only, and the Web Lock keeps other tabs out, so a
		// persistent file never has a competing lock to check against.
		lock(fileId: number, level: number): number {
			return persistent(fileId) ? SQLITE_OK : memory.lock(fileId, level);
		},

		unlock(fileId: number, level: number): number {
			return persistent(fileId) ? SQLITE_OK : memory.unlock(fileId, level);
		},

		checkReserved(fileId: number): boolean {
			return persistent(fileId) ? false : memory.checkReserved(fileId);
		},

		close(fileId: number): number {
			// A persistent file's handle stays open until release(): SQLite closes and reopens journals freely.
			if (opened.delete(fileId)) return SQLITE_OK;
			return memory.close(fileId);
		},

		sectorSize(): number {
			return 4096;
		},

		// OPFS makes no atomic-write, safe-append or power-safe-overwrite promise, so none of those bits are claimed.
		deviceCharacteristics(fileId: number): number {
			return persistent(fileId) ? SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN : memory.deviceCharacteristics();
		}
	};
}

/** The driver factory, as a namespace: `opfs.create(options)`. */
const opfs = { create, normalize };
export default opfs;
