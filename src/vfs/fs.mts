/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/fs.mts
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
 * @fileoverview Node storage driver: real files on disk through synchronous `node:fs` calls.
 *
 * Locking works on two levels:
 *
 * - Across processes, a main database is owned by one process at a time. Opening it takes an owner lock: a directory
 *   `<db>.lock/` holding `owner.json` ({ pid, hostname, started }). The directory is built under a temporary name and
 *   renamed into place, so it appears atomically and always with its owner file. A lock whose pid is dead on this
 *   host is stale and gets taken over; a live owner makes the open wait up to `timeout` ms and then fail with
 *   SQLITE_BUSY. Node has no fcntl locks, which is why this exists; native SQLite doesn't know about it.
 * - Within the process, the lock levels SQLite asks for (shared, reserved, pending, exclusive) are tracked in JS per
 *   file, shared by every driver object, so two connections in one process arbitrate like they would on disk.
 *
 * Taking over a stale lock is itself serialized: the taker first claims `<db>.lock/reap` (the same kind of lock, one
 * level down), checks that the stale owner is still the one it saw, and only then removes the directory. Two takers
 * can't both remove it, and a taker that sees a fresh owner backs off.
 */
import {
	closeSync,
	constants,
	existsSync,
	fdatasyncSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	accessSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
	SQLITE_ACCESS_EXISTS,
	SQLITE_ACCESS_READWRITE,
	SQLITE_BUSY,
	SQLITE_CANTOPEN,
	SQLITE_IOCAP_POWERSAFE_OVERWRITE,
	SQLITE_IOERR_DELETE_NOENT,
	SQLITE_IOERR_SHORT_READ,
	SQLITE_LOCK_NONE,
	SQLITE_LOCK_PENDING,
	SQLITE_LOCK_RESERVED,
	SQLITE_LOCK_SHARED,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_DELETEONCLOSE,
	SQLITE_OPEN_EXCLUSIVE,
	SQLITE_OPEN_MAIN_DB,
	SQLITE_OPEN_READONLY
} from "../core/constants.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";

/** xSync flag: only the data needs to reach the disk, not the metadata (sqlite3.h). */
const SQLITE_SYNC_DATAONLY = 0x10;
/** How long the owner-lock wait sleeps between attempts, in ms. */
const POLL_MS = 25;
/** Default for `options.timeout`, in ms. */
const DEFAULT_TIMEOUT = 5000;

/** Options for `create()`. */
export interface options {
	/** How long opening a database waits for another process's owner lock before SQLITE_BUSY, in ms. Default 5000. */
	timeout?: number;
}

/** The contents of `owner.json`. */
interface owner {
	pid: number;
	hostname: string;
	started: string;
}

/** An owner lock this process holds, shared by every handle open on the same database. */
interface held {
	record: owner;
	count: number;
}

/** An open file. */
interface handle {
	fd: number;
	path: string;
	deleteOnClose: boolean;
	/** The owner-lock directory, for a main database. */
	lock?: string;
}

/** Owner locks this process holds, by lock directory. */
const owners = new Map<string, held>();
/** SQLite lock levels per file path, then per file id; shared by every driver object in the process. */
const levels = new Map<string, Map<number, number>>();
/** Whether the exit handler that releases owner locks is registered. */
let exitHook = false;

/** Blocks the thread for `ms` milliseconds (the driver API is synchronous). */
function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A name for a sibling of `path` that no other process or call uses. */
function unique(path: string, suffix: string): string {
	return `${path}.${process.pid}-${randomBytes(6).toString("hex")}.${suffix}`;
}

/** Flushes a directory entry change (create, delete, rename) in `directory` to disk. */
function syncDirectory(directory: string): void {
	/* v8 ignore next 2 -- Windows can't open a directory for fsync and doesn't need it; CI runs on Linux. */
	if (process.platform === "win32") return;
	const fd = openSync(directory, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Reads `<dir>/owner.json`; undefined when it is missing or not a valid owner record. */
function readOwner(directory: string): owner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<owner>;
		if (
			Number.isSafeInteger(parsed.pid) &&
			(parsed.pid as number) > 0 &&
			typeof parsed.hostname === "string" &&
			typeof parsed.started === "string"
		) {
			return parsed as owner;
		}
	} catch {
		// Missing or unreadable: treated like a lock nobody can vouch for.
	}
	return undefined;
}

/** Whether `record`'s process may still be running. An owner on another host can't be checked, so it counts as live. */
function alive(record: owner): boolean {
	if (record.hostname !== hostname()) return true;
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether two owner records (either possibly missing) describe the same lock. */
function same(a: owner | undefined, b: owner | undefined): boolean {
	return a?.pid === b?.pid && a?.hostname === b?.hostname && a?.started === b?.started;
}

/** Removes a lock directory: renamed away first, so its path is free at once, then deleted. */
function remove(directory: string, root: string): void {
	const grave = unique(root, "dead");
	try {
		renameSync(directory, grave);
	} catch (error) {
		// Someone else removed it already.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	rmSync(grave, { recursive: true, force: true });
}

/**
 * Tries once to create the lock directory `directory` with `record` as its owner. False when something is already
 * there (or, one level down, when the parent lock has gone away in the meantime).
 */
function place(directory: string, root: string, record: owner): boolean {
	// Temporary directories sit beside the top-level lock so the rename stays on one filesystem.
	const temp = unique(root, "tmp");
	mkdirSync(temp);
	writeFileSync(join(temp, "owner.json"), JSON.stringify(record));
	try {
		renameSync(temp, directory);
		return true;
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOENT") return false;
		throw error;
	}
}

/** Result of one attempt at a lock: held by us, held by a live owner, or changed under us (try again at once). */
type attempt = "held" | "busy" | "retry";

/** One attempt at the lock directory `directory` (`root` is the top-level lock it belongs to). */
function claim(directory: string, root: string, record: owner): attempt {
	if (place(directory, root, record)) return "held";
	const found = readOwner(directory);
	// Released between our attempt and the read.
	if (found === undefined && !existsSync(directory)) return "retry";
	if (found !== undefined && alive(found)) return "busy";
	// A stale lock. Take it over under a nested lock so only one process removes it.
	const reap = join(directory, "reap");
	const reaping = claim(reap, root, record);
	if (reaping !== "held") return reaping;
	if (same(readOwner(directory), found)) remove(directory, root);
	// Otherwise a new owner took the place between our read and the claim: leave it alone.
	else remove(reap, root);
	return "retry";
}

/** Takes the owner lock for the database at `path`; false when another process kept it for `timeout` ms. */
function acquire(path: string, timeout: number): string | undefined {
	const directory = `${path}.lock`;
	const existing = owners.get(directory);
	if (existing) {
		existing.count++;
		return directory;
	}
	const record: owner = { pid: process.pid, hostname: hostname(), started: new Date().toISOString() };
	const deadline = Date.now() + timeout;
	for (;;) {
		const result = claim(directory, directory, record);
		if (result === "held") break;
		if (result === "busy") {
			const left = deadline - Date.now();
			if (left <= 0) return undefined;
			sleep(Math.min(POLL_MS, left));
		}
	}
	owners.set(directory, { record, count: 1 });
	if (!exitHook) {
		exitHook = true;
		// Best effort: a normal exit releases every lock still held. A killed process leaves a stale lock instead.
		process.on("exit", () => {
			for (const directory of [...owners.keys()]) release(directory, true);
		});
	}
	return directory;
}

/** Drops one reference to an owner lock; the directory goes when the last one does (or at once with `all`). */
function release(directory: string, all = false): void {
	const entry = owners.get(directory);
	// Already released by the exit handler.
	if (!entry) return;
	if (--entry.count > 0 && !all) return;
	owners.delete(directory);
	// Only remove the directory while it is still ours.
	if (same(readOwner(directory), entry.record)) remove(directory, directory);
}

/** The lock-level table for `path`. */
function table(path: string): Map<number, number> {
	let found = levels.get(path);
	if (!found) {
		found = new Map();
		levels.set(path, found);
	}
	return found;
}

/** Driver for real files on disk. */
class driver implements VfsDriver {
	readonly #timeout: number;
	readonly #handles = new Map<number, handle>();

	constructor(timeout: number) {
		this.#timeout = timeout;
	}

	#handle(fileId: number): handle {
		const found = this.#handles.get(fileId);
		if (!found) throw new Error(`fs driver: no open file with id ${fileId}`);
		return found;
	}

	open(name: string | null, fileId: number, flags: number): number {
		const temporary = name === null;
		const path = temporary ? join(tmpdir(), `sqlite-wasm-${process.pid}-${fileId}-${randomBytes(6).toString("hex")}`) : resolve(name);
		let mode = flags & SQLITE_OPEN_READONLY ? constants.O_RDONLY : constants.O_RDWR;
		if (flags & SQLITE_OPEN_CREATE || temporary) mode |= constants.O_CREAT;
		if ((flags & SQLITE_OPEN_EXCLUSIVE && flags & SQLITE_OPEN_CREATE) || temporary) mode |= constants.O_EXCL;
		const existed = existsSync(path);
		let fd: number;
		try {
			fd = openSync(path, mode, 0o644);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return SQLITE_CANTOPEN;
			throw error;
		}
		const entry: handle = { fd, path, deleteOnClose: temporary || (flags & SQLITE_OPEN_DELETEONCLOSE) !== 0 };
		try {
			if (!existed && !entry.deleteOnClose) syncDirectory(dirname(path));
			if (flags & SQLITE_OPEN_MAIN_DB) {
				const lock = acquire(path, this.#timeout);
				if (lock === undefined) {
					closeSync(fd);
					return SQLITE_BUSY;
				}
				entry.lock = lock;
			}
		} catch (error) {
			closeSync(fd);
			throw error;
		}
		table(path).set(fileId, SQLITE_LOCK_NONE);
		this.#handles.set(fileId, entry);
		return SQLITE_OK;
	}

	delete(name: string): number {
		const path = resolve(name);
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return SQLITE_IOERR_DELETE_NOENT;
			throw error;
		}
		syncDirectory(dirname(path));
		return SQLITE_OK;
	}

	access(name: string, flags: number): boolean {
		const path = resolve(name);
		if (flags === SQLITE_ACCESS_EXISTS) {
			// As in SQLite's unix VFS: an empty regular file counts as missing (a truncated journal is not hot).
			try {
				const stats = statSync(path);
				return !stats.isFile() || stats.size > 0;
			} catch {
				return false;
			}
		}
		try {
			accessSync(path, flags === SQLITE_ACCESS_READWRITE ? constants.R_OK | constants.W_OK : constants.R_OK);
			return true;
		} catch {
			return false;
		}
	}

	fullPathname(name: string): string {
		return resolve(name);
	}

	read(fileId: number, target: Uint8Array, offset: number): number {
		const { fd } = this.#handle(fileId);
		let done = 0;
		while (done < target.length) {
			const count = readSync(fd, target, done, target.length - done, offset + done);
			if (count === 0) break;
			done += count;
		}
		if (done === target.length) return SQLITE_OK;
		target.fill(0, done);
		return SQLITE_IOERR_SHORT_READ;
	}

	write(fileId: number, data: Uint8Array, offset: number): number {
		const { fd } = this.#handle(fileId);
		let done = 0;
		while (done < data.length) done += writeSync(fd, data, done, data.length - done, offset + done);
		return SQLITE_OK;
	}

	truncate(fileId: number, size: number): number {
		ftruncateSync(this.#handle(fileId).fd, size);
		return SQLITE_OK;
	}

	sync(fileId: number, flags: number): number {
		const { fd } = this.#handle(fileId);
		if (flags & SQLITE_SYNC_DATAONLY) fdatasyncSync(fd);
		else fsyncSync(fd);
		return SQLITE_OK;
	}

	size(fileId: number): number {
		return fstatSync(this.#handle(fileId).fd).size;
	}

	lock(fileId: number, level: number): number {
		const { path } = this.#handle(fileId);
		const locks = table(path);
		let readers = false;
		for (const [other, held] of locks) {
			if (other === fileId) continue;
			// SHARED waits out a writer that is about to commit; RESERVED allows one writer.
			if (level === SQLITE_LOCK_SHARED ? held >= SQLITE_LOCK_PENDING : held >= SQLITE_LOCK_RESERVED) return SQLITE_BUSY;
			if (held > SQLITE_LOCK_NONE) readers = true;
		}
		// EXCLUSIVE needs every reader gone. Until then the writer sits at PENDING, which keeps new readers out, as in
		// SQLite's own VFSes.
		if (readers && level > SQLITE_LOCK_RESERVED) {
			locks.set(fileId, SQLITE_LOCK_PENDING);
			return SQLITE_BUSY;
		}
		locks.set(fileId, level);
		return SQLITE_OK;
	}

	unlock(fileId: number, level: number): number {
		table(this.#handle(fileId).path).set(fileId, level);
		return SQLITE_OK;
	}

	checkReserved(fileId: number): boolean {
		const { path } = this.#handle(fileId);
		for (const [other, held] of table(path)) if (other !== fileId && held >= SQLITE_LOCK_RESERVED) return true;
		return false;
	}

	close(fileId: number): number {
		const entry = this.#handle(fileId);
		this.#handles.delete(fileId);
		const locks = table(entry.path);
		locks.delete(fileId);
		if (locks.size === 0) levels.delete(entry.path);
		closeSync(entry.fd);
		// A delete-on-close file is scratch space: its directory entry never needs to survive a crash.
		if (entry.deleteOnClose) rmSync(entry.path, { force: true });
		if (entry.lock) release(entry.lock);
		return SQLITE_OK;
	}

	sectorSize(): number {
		return 4096;
	}

	deviceCharacteristics(): number {
		return SQLITE_IOCAP_POWERSAFE_OVERWRITE;
	}
}

/**
 * Creates a driver for real files. One driver can serve any number of connections; locks are tracked per process.
 * @param settings  `timeout`: how long an open waits for another process's owner lock (ms, default 5000)
 */
export function create(settings: options = {}): VfsDriver {
	return new driver(settings.timeout ?? DEFAULT_TIMEOUT);
}
