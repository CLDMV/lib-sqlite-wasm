/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/vfs/fs.mts
 *	@Date: 2026-11-25T01:49:24-08:00 (1795600164)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:20:58-08:00 (1795634458)
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
 *
 * Where the owner lock lives is the `lock` option `sqlite.open()` passes to `prepare()` (DESIGN.md, "Lock option"):
 *   - "beside" (default): `<db>.lock/`, falling back to "temp" when that folder can't be created (a read-only
 *     database in a folder this process can't write to);
 *   - "temp": `<os.tmpdir()>/cldmv-sqlite-locks-<uid>/<sha256 of the real path>/`, private to the user: the root is
 *     created with mode 0700 and refused when it is a symlink, isn't a directory, belongs to another user, or is group-
 *     or world-writable. Every process of one user finds the same root. Where there are no uids (Windows) it is
 *     `cldmv-sqlite-locks/`, unchecked;
 *   - a folder path: `<folder>/<sha256 of the real path>/`;
 *   - "db": no folder at all; `sqlite.open()` keeps a row in a `_cldmv_lock` table instead (detects, doesn't prevent).
 * The hash is of the file's resolved real path, so two paths to one file (a symlink, `..`) share one lock. A file
 * opened without `prepare()` (the driver used on its own) gets the "beside" lock at open, as before.
 *
 * Temporary files SQLite asks for without a name (sorts, temp tables, statement journals) hold database data, so they go
 * in a folder private to this process: made on first use with `mkdtemp` (mode 0700) under `os.tmpdir()`, files inside it
 * created exclusively with mode 0600, and the folder removed when the process exits normally.
 */
import {
	closeSync,
	constants,
	existsSync,
	fdatasyncSync,
	lstatSync,
	mkdtempSync,
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
	realpathSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { error } from "../api/error.mts";
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

/** Options for `prepare()`; `sqlite.open()` passes its own (path, readonly and create are not used here). */
export interface preparation {
	/** How long to wait for another process's lock, in ms; the driver's own timeout when omitted. */
	timeout?: number;
	/** "beside" (default), "temp", "db" or a folder path. */
	lock?: string;
}

/** A database `prepare()` has set up: the lock kind in effect and its folder (none for "db"). */
interface prepared {
	kind: string;
	directory: string | undefined;
	count: number;
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
/** Databases `prepare()` set up, by resolved path; shared by every driver object in the process. */
const preparations = new Map<string, prepared>();
/** SQLite lock levels per file path, then per file id; shared by every driver object in the process. */
const levels = new Map<string, Map<number, number>>();
/** Whether the exit handler that releases owner locks and removes the temporary-file folder is registered. */
let exitHook = false;
/** This process's private folder for unnamed temporary files, once made. */
let scratch: string | undefined;

/** Permission bits for what a lock writes: the lock directories and their `owner.json`. */
interface modes {
	directory: number;
	file: number;
}

/**
 * Locks beside a database or in a chosen folder: the process umask decides, so other users who share the database can
 * read the owner record and wait for a live owner instead of failing.
 */
const SHARED: modes = { directory: 0o777, file: 0o666 };
/** Locks under the per-user "temp" root: nobody else needs to read them. */
const PRIVATE: modes = { directory: 0o700, file: 0o600 };

/** Registers, once per process, the exit handler that releases every owner lock and removes the temporary-file folder. */
function onExit(): void {
	if (exitHook) return;
	exitHook = true;
	// Best effort: a normal exit releases every lock still held and removes the temporary files. A killed process leaves
	// a stale lock (taken over later) and its private folder behind.
	process.on("exit", () => {
		for (const directory of [...owners.keys()]) release(directory, true);
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
	});
}

/** This process's private folder for temporary files: made on first use (mkdtemp, mode 0700). */
function scratchFolder(): string {
	if (scratch === undefined) {
		scratch = mkdtempSync(join(tmpdir(), "sqlite-wasm-"));
		onExit();
	}
	return scratch;
}

/**
 * Opens `path` with the open flags `mode` (no O_CREAT/O_EXCL in it) and says whether this call created the file.
 * With `create`, the file is created when missing; with `exclusive` as well, an existing file is an error (EEXIST).
 * Creating is tried first with O_EXCL, so `created` comes from the open itself rather than from a separate check.
 * Undefined when the file (or its folder) doesn't exist and can't be created.
 */
function openFile(
	path: string,
	mode: number,
	create: boolean,
	exclusive: boolean,
	permissions: number
): { fd: number; created: boolean } | undefined {
	for (;;) {
		if (create) {
			try {
				return { fd: openSync(path, mode | constants.O_CREAT | constants.O_EXCL, permissions), created: true };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// A missing folder: nothing can be created there.
				if (code === "ENOENT") return undefined;
				if (code !== "EEXIST" || exclusive) throw error;
			}
		}
		try {
			return { fd: openSync(path, mode), created: false };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!create) return undefined;
			// It existed a moment ago and was deleted before we opened it: try creating it again.
		}
	}
}

/**
 * The root folder of "temp" locks. On POSIX it is per user and must be private: created with mode 0700, and refused
 * when it is a symlink or not a directory, belongs to another user, or is group- or world-writable (another user could
 * otherwise pre-create it, or plant a link, and see or steal every lock in it).
 */
export function temporaryLocks(): string {
	const uid = process.getuid?.();
	// Windows has no uids (process.getuid is missing) and no shared-tmp permission model to check.
	if (uid === undefined) {
		const root = join(tmpdir(), "cldmv-sqlite-locks");
		mkdirSync(root, { recursive: true });
		return root;
	}
	const root = join(tmpdir(), `cldmv-sqlite-locks-${uid}`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stats = lstatSync(root);
	let problem: string | undefined;
	if (stats.isSymbolicLink()) problem = "is a symbolic link";
	else if (!stats.isDirectory()) problem = "is not a directory";
	else if (stats.uid !== uid) problem = `belongs to uid ${stats.uid}, not ${uid}`;
	else if (stats.mode & 0o022) problem = `is writable by other users (mode ${(stats.mode & 0o777).toString(8)})`;
	if (problem !== undefined) throw new Error(`refusing the temp lock folder "${root}": it ${problem}`);
	return root;
}

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
function place(directory: string, root: string, record: owner, modes: modes): boolean {
	// Temporary directories sit beside the top-level lock so the rename stays on one filesystem.
	const temp = unique(root, "tmp");
	mkdirSync(temp, { mode: modes.directory });
	writeFileSync(join(temp, "owner.json"), JSON.stringify(record), { mode: modes.file });
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
function claim(directory: string, root: string, record: owner, modes: modes): attempt {
	if (place(directory, root, record, modes)) return "held";
	const found = readOwner(directory);
	// Released between our attempt and the read.
	if (found === undefined && !existsSync(directory)) return "retry";
	if (found !== undefined && alive(found)) return "busy";
	// A stale lock. Take it over under a nested lock so only one process removes it.
	const reap = join(directory, "reap");
	const reaping = claim(reap, root, record, modes);
	if (reaping !== "held") return reaping;
	if (same(readOwner(directory), found)) remove(directory, root);
	// Otherwise a new owner took the place between our read and the claim: leave it alone.
	else remove(reap, root);
	return "retry";
}

/** Records a lock directory this process now holds (or one more reference to it). */
function hold(directory: string, record: owner): void {
	owners.set(directory, { record, count: 1 });
	onExit();
}

/** A fresh owner record for this process. */
function self(): owner {
	return { pid: process.pid, hostname: hostname(), started: new Date().toISOString() };
}

/** One attempt at `directory` until it is either ours or held by a live owner. */
function settle(directory: string, record: owner, modes: modes = SHARED): "held" | "busy" {
	for (;;) {
		const result = claim(directory, directory, record, modes);
		if (result !== "retry") return result;
	}
}

/** Takes the owner lock for the database at `path` (beside it); undefined when another process kept it for `timeout` ms. */
function acquire(path: string, timeout: number): string | undefined {
	const directory = `${path}.lock`;
	const existing = owners.get(directory);
	if (existing) {
		existing.count++;
		return directory;
	}
	const record = self();
	const deadline = Date.now() + timeout;
	while (settle(directory, record) === "busy") {
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		sleep(Math.min(POLL_MS, left));
	}
	hold(directory, record);
	return directory;
}

/** Like `acquire()`, for any lock directory, waiting without blocking the thread. False on timeout. */
async function enter(directory: string, timeout: number, modes: modes = SHARED): Promise<boolean> {
	const existing = owners.get(directory);
	if (existing) {
		existing.count++;
		return true;
	}
	const record = self();
	const deadline = Date.now() + timeout;
	while (settle(directory, record, modes) === "busy") {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		await delay(Math.min(POLL_MS, left));
	}
	hold(directory, record);
	return true;
}

/** The resolved real path of a database file, or of its folder plus its name when the file doesn't exist yet. */
export function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

/** The lock folder for `path` under `parent`: named by the SHA-256 of the file's real path. */
export function hashed(parent: string, path: string): string {
	return join(parent, createHash("sha256").update(real(path)).digest("hex"));
}

/** Errors that mean "this folder can't be written here", for which "beside" falls back to "temp". */
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

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

/** The error for a database whose lock another live process kept for the whole timeout. */
function busy(path: string, directory: string): error {
	return new error(`database "${path}" is locked by another process (lock folder ${directory})`, SQLITE_BUSY);
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
export class driver implements VfsDriver {
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

	/**
	 * Takes the owner lock of the kind `settings.lock` asks for and returns the name SQLite opens (the resolved path).
	 * Waits for another process up to `settings.timeout`, then fails with SQLITE_BUSY.
	 */
	async prepare(path: string, settings: preparation = {}): Promise<string> {
		const name = resolve(path);
		try {
			return await this.#prepare(name, settings);
		} catch (thrown) {
			if (thrown instanceof error) throw thrown;
			// The lock folder couldn't be made at all (a missing parent folder, a file in the way).
			throw new error(`cannot lock "${name}": ${(thrown as Error).message}`, SQLITE_CANTOPEN, undefined, { cause: thrown });
		}
	}

	async #prepare(name: string, settings: preparation): Promise<string> {
		const existing = preparations.get(name);
		if (existing) {
			if (existing.directory !== undefined) await enter(existing.directory, 0);
			existing.count++;
			return name;
		}
		const timeout = settings.timeout ?? this.#timeout;
		const requested = settings.lock ?? "beside";
		let kind = requested;
		let directory: string | undefined;
		if (requested !== "db") {
			if (requested === "beside") {
				directory = `${name}.lock`;
				try {
					if (!(await enter(directory, timeout))) throw busy(name, directory);
				} catch (thrown) {
					if (!UNWRITABLE.has((thrown as NodeJS.ErrnoException).code as string)) throw thrown;
					kind = "temp";
					directory = undefined;
				}
			}
			if (directory === undefined) {
				if (kind === "temp") directory = hashed(temporaryLocks(), name);
				else {
					const parent = resolve(requested);
					mkdirSync(parent, { recursive: true });
					directory = hashed(parent, name);
				}
				if (!(await enter(directory, timeout, kind === "temp" ? PRIVATE : SHARED))) throw busy(name, directory);
			}
		}
		preparations.set(name, { kind, directory, count: 1 });
		return name;
	}

	/** Drops what `prepare()` took for `name`. */
	release(name: string): void {
		const entry = preparations.get(name);
		if (!entry) return;
		if (entry.directory !== undefined) release(entry.directory);
		if (--entry.count === 0) preparations.delete(name);
	}

	/** The lock kind in effect for a prepared `name` ("beside" for a file opened without `prepare()`). */
	held(name: string): string {
		return preparations.get(name)?.kind ?? "beside";
	}

	open(name: string | null, fileId: number, flags: number): number {
		const temporary = name === null;
		const mode = flags & SQLITE_OPEN_READONLY ? constants.O_RDONLY : constants.O_RDWR;
		const create = temporary || (flags & SQLITE_OPEN_CREATE) !== 0;
		const exclusive = temporary || (flags & SQLITE_OPEN_EXCLUSIVE && flags & SQLITE_OPEN_CREATE) !== 0;
		// Temporary files hold database data: private to the user, in this process's private folder.
		const permissions = temporary ? 0o600 : 0o644;
		const base = `${fileId}-${randomBytes(6).toString("hex")}`;
		let path = temporary ? join(scratchFolder(), base) : resolve(name);
		let opened = openFile(path, mode, create, exclusive, permissions);
		if (opened === undefined && temporary) {
			// The private folder was removed under us (a temp cleaner): make a new one.
			scratch = undefined;
			path = join(scratchFolder(), base);
			opened = openFile(path, mode, create, exclusive, permissions);
		}
		if (opened === undefined) return SQLITE_CANTOPEN;
		const { fd, created } = opened;
		const entry: handle = { fd, path, deleteOnClose: temporary || (flags & SQLITE_OPEN_DELETEONCLOSE) !== 0 };
		try {
			if (created && !entry.deleteOnClose) syncDirectory(dirname(path));
			// A prepared database already holds its lock (or, for "db", deliberately none).
			if (flags & SQLITE_OPEN_MAIN_DB && !preparations.has(path)) {
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
export function create(settings: options = {}): driver {
	return new driver(settings.timeout ?? DEFAULT_TIMEOUT);
}
