/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/vfs-imports.mts
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
 * @fileoverview The JS side of the C <-> JS VFS contract: the `env.vfs_*` imports glue.c calls, and the driver
 * interface they dispatch to.
 *
 * A driver never sees wasm memory. This module converts pointers and split 64-bit offsets into strings, numbers and
 * Uint8Array views, writes out-parameters back, and turns a thrown exception into the SQLite error code for that
 * method (an exception must never unwind through wasm frames).
 */
import {
	SQLITE_CANTOPEN,
	SQLITE_IOERR_ACCESS,
	SQLITE_IOERR_CHECKRESERVEDLOCK,
	SQLITE_IOERR_CLOSE,
	SQLITE_IOERR_DELETE,
	SQLITE_IOERR_FSTAT,
	SQLITE_IOERR_FSYNC,
	SQLITE_IOERR_LOCK,
	SQLITE_IOERR_READ,
	SQLITE_IOERR_TRUNCATE,
	SQLITE_IOERR_UNLOCK,
	SQLITE_IOERR_WRITE,
	SQLITE_OK
} from "./constants.mts";
import type { WasmMemory } from "./memory.mts";

/**
 * A storage driver. Every method is synchronous and returns an SQLite result code unless noted. File ids are unique
 * across every module instance in the process, so one driver object can serve several connections.
 */
export interface VfsDriver {
	/** Opens or creates `name` (null: a temporary file the driver names itself) as `fileId`. */
	open(name: string | null, fileId: number, flags: number): number;
	/** Deletes `name`; `SQLITE_IOERR_DELETE_NOENT` when it doesn't exist. */
	delete(name: string, syncDir: boolean): number;
	/** Whether `name` exists / is readable / writable (`flags` is a SQLITE_ACCESS_* value). */
	access(name: string, flags: number): boolean;
	/** The canonical name for `name`; journal and WAL names are derived from it. */
	fullPathname(name: string): string;
	/** Fills `target` from `offset`. A short read zero-fills the rest and returns `SQLITE_IOERR_SHORT_READ`. `target` is a view into wasm memory: copy out of it, never keep it. */
	read(fileId: number, target: Uint8Array, offset: number): number;
	/** Writes `data` at `offset`, growing the file as needed. `data` is a view into wasm memory: copy it, never keep it. */
	write(fileId: number, data: Uint8Array, offset: number): number;
	truncate(fileId: number, size: number): number;
	sync(fileId: number, flags: number): number;
	/** The file's size in bytes (not a result code). */
	size(fileId: number): number;
	lock(fileId: number, level: number): number;
	unlock(fileId: number, level: number): number;
	/** Whether any connection holds a RESERVED or higher lock on the file (not a result code). */
	checkReserved(fileId: number): boolean;
	close(fileId: number): number;
	/** Sector size in bytes (not a result code). */
	sectorSize(fileId: number): number;
	/** SQLITE_IOCAP_* bits (not a result code). */
	deviceCharacteristics(fileId: number): number;
}

/** Offset between the Unix epoch and Julian day 0, in milliseconds (what xCurrentTimeInt64 counts from). */
const JULIAN_EPOCH_MS = 210866760000000;
/** crypto.getRandomValues() refuses more than this many bytes per call. */
const RANDOM_CHUNK = 65536;

/** Source of process-wide file ids. glue.c numbers files per instance; drivers see these instead. */
let nextFileId = 1;

/** Combines the two 32-bit halves glue.c passes for a 64-bit offset. */
export function joinOffset(lo: number, hi: number): number {
	return hi * 0x100000000 + (lo >>> 0);
}

/** Called with whatever a driver threw before its import returned an error code. */
export type VfsErrorHandler = (error: unknown) => void;

/**
 * Builds the `env.vfs_*` import functions for one module instance.
 * @param driver   where the calls go
 * @param memory   the instance's memory; read lazily, since the imports object is built before instantiation
 * @param onError  receives exceptions thrown by the driver
 */
export function createVfsImports(
	driver: VfsDriver,
	memory: () => WasmMemory,
	onError: VfsErrorHandler
): Record<string, (...args: number[]) => number> {
	/** Runs `body`; a thrown exception is reported and becomes `failure`. */
	const guard = (failure: number, body: () => number): number => {
		try {
			return body();
		} catch (error) {
			onError(error);
			return failure;
		}
	};
	const name = (pointer: number): string => memory().readCString(pointer) as string;
	// glue.c's per-instance file id -> process-wide id handed to the driver.
	const ids = new Map<number, number>();
	const id = (local: number): number => ids.get(local) as number;

	return {
		vfs_open: (namePointer, localId, flags, outFlags) =>
			guard(SQLITE_CANTOPEN, () => {
				const fileId = nextFileId++;
				const rc = driver.open(memory().readCString(namePointer), fileId, flags);
				if (rc === SQLITE_OK) {
					ids.set(localId, fileId);
					memory().view().setInt32(outFlags, flags, true);
				}
				return rc;
			}),
		vfs_delete: (namePointer, syncDir) => guard(SQLITE_IOERR_DELETE, () => driver.delete(name(namePointer), syncDir !== 0)),
		vfs_access: (namePointer, flags, out) =>
			guard(SQLITE_IOERR_ACCESS, () => {
				memory()
					.view()
					.setInt32(out, driver.access(name(namePointer), flags) ? 1 : 0, true);
				return SQLITE_OK;
			}),
		vfs_fullpath: (namePointer, capacity, out) =>
			guard(SQLITE_CANTOPEN, () =>
				memory().writeCString(out, capacity, driver.fullPathname(name(namePointer))) ? SQLITE_OK : SQLITE_CANTOPEN
			),
		vfs_read: (fileId, buffer, amount, lo, hi) =>
			guard(SQLITE_IOERR_READ, () =>
				driver.read(
					id(fileId),
					memory()
						.bytes()
						.subarray(buffer, buffer + amount),
					joinOffset(lo, hi)
				)
			),
		vfs_write: (fileId, buffer, amount, lo, hi) =>
			guard(SQLITE_IOERR_WRITE, () =>
				driver.write(
					id(fileId),
					memory()
						.bytes()
						.subarray(buffer, buffer + amount),
					joinOffset(lo, hi)
				)
			),
		vfs_truncate: (fileId, lo, hi) => guard(SQLITE_IOERR_TRUNCATE, () => driver.truncate(id(fileId), joinOffset(lo, hi))),
		vfs_sync: (fileId, flags) => guard(SQLITE_IOERR_FSYNC, () => driver.sync(id(fileId), flags)),
		vfs_size: (fileId, out) =>
			guard(SQLITE_IOERR_FSTAT, () => {
				memory()
					.view()
					.setBigInt64(out, BigInt(driver.size(id(fileId))), true);
				return SQLITE_OK;
			}),
		vfs_lock: (fileId, level) => guard(SQLITE_IOERR_LOCK, () => driver.lock(id(fileId), level)),
		vfs_unlock: (fileId, level) => guard(SQLITE_IOERR_UNLOCK, () => driver.unlock(id(fileId), level)),
		vfs_check_reserved: (fileId, out) =>
			guard(SQLITE_IOERR_CHECKRESERVEDLOCK, () => {
				memory()
					.view()
					.setInt32(out, driver.checkReserved(id(fileId)) ? 1 : 0, true);
				return SQLITE_OK;
			}),
		vfs_close: (fileId) =>
			guard(SQLITE_IOERR_CLOSE, () => {
				const global = id(fileId);
				ids.delete(fileId);
				return driver.close(global);
			}),
		// Not result codes: fall back to SQLite's own defaults.
		vfs_sector_size: (fileId) => guard(4096, () => driver.sectorSize(id(fileId))),
		vfs_device_characteristics: (fileId) => guard(0, () => driver.deviceCharacteristics(id(fileId))),
		vfs_randomness: (count, out) => {
			const target = memory()
				.bytes()
				.subarray(out, out + count);
			for (let at = 0; at < count; at += RANDOM_CHUNK) crypto.getRandomValues(target.subarray(at, at + RANDOM_CHUNK));
			return count;
		},
		vfs_current_time_ms: (out) => {
			memory()
				.view()
				.setBigInt64(out, BigInt(Date.now() + JULIAN_EPOCH_MS), true);
			return SQLITE_OK;
		},
		vfs_sleep: (microseconds) => {
			// Atomics.wait blocks without spinning; it works in Node and in workers (where the drivers run).
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(microseconds / 1000));
			return microseconds;
		}
	};
}
