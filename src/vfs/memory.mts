/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/vfs/memory.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
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
 * @fileoverview In-memory storage driver: one growable buffer per file name, shared by every connection that uses
 * the same driver object, with SQLite's lock levels tracked per open handle.
 *
 * Used by tests and for named in-memory databases. A database's -journal and -wal files are ordinary files here.
 */
import {
	SQLITE_BUSY,
	SQLITE_CANTOPEN,
	SQLITE_IOCAP_POWERSAFE_OVERWRITE,
	SQLITE_IOCAP_SAFE_APPEND,
	SQLITE_IOERR_DELETE_NOENT,
	SQLITE_IOERR_SHORT_READ,
	SQLITE_LOCK_NONE,
	SQLITE_LOCK_PENDING,
	SQLITE_LOCK_RESERVED,
	SQLITE_LOCK_SHARED,
	SQLITE_OK,
	SQLITE_OPEN_CREATE,
	SQLITE_OPEN_DELETEONCLOSE
} from "../core/constants.mts";
import type { VfsDriver } from "../core/vfs-imports.mts";

/** One file's contents and the lock level each open handle holds on it. */
interface MemoryFile {
	data: Uint8Array;
	size: number;
	locks: Map<number, number>;
}

/** An open handle. */
interface Handle {
	name: string;
	file: MemoryFile;
	deleteOnClose: boolean;
}

/** Storage driver that keeps every file in memory. */
export class MemoryDriver implements VfsDriver {
	readonly #files = new Map<string, MemoryFile>();
	readonly #handles = new Map<number, Handle>();

	/** Names of the files that currently exist. */
	files(): string[] {
		return [...this.#files.keys()];
	}

	/** A copy of a file's contents, or undefined when it doesn't exist. */
	contents(name: string): Uint8Array | undefined {
		const file = this.#files.get(name);
		return file && file.data.slice(0, file.size);
	}

	#handle(fileId: number): Handle {
		const handle = this.#handles.get(fileId);
		if (!handle) throw new Error(`memory driver: no open file with id ${fileId}`);
		return handle;
	}

	open(name: string | null, fileId: number, flags: number): number {
		const path = name ?? `temp-${fileId}`;
		let file = this.#files.get(path);
		if (!file) {
			if (!(flags & SQLITE_OPEN_CREATE)) return SQLITE_CANTOPEN;
			file = { data: new Uint8Array(0), size: 0, locks: new Map() };
			this.#files.set(path, file);
		}
		file.locks.set(fileId, SQLITE_LOCK_NONE);
		this.#handles.set(fileId, { name: path, file, deleteOnClose: name === null || (flags & SQLITE_OPEN_DELETEONCLOSE) !== 0 });
		return SQLITE_OK;
	}

	delete(name: string): number {
		return this.#files.delete(name) ? SQLITE_OK : SQLITE_IOERR_DELETE_NOENT;
	}

	access(name: string): boolean {
		return this.#files.has(name);
	}

	fullPathname(name: string): string {
		return name;
	}

	read(fileId: number, target: Uint8Array, offset: number): number {
		const { file } = this.#handle(fileId);
		const available = Math.max(0, Math.min(target.length, file.size - offset));
		target.set(file.data.subarray(offset, offset + available));
		if (available === target.length) return SQLITE_OK;
		target.fill(0, available);
		return SQLITE_IOERR_SHORT_READ;
	}

	write(fileId: number, data: Uint8Array, offset: number): number {
		const { file } = this.#handle(fileId);
		const end = offset + data.length;
		if (end > file.data.length) {
			const grown = new Uint8Array(Math.max(end, file.data.length * 2));
			grown.set(file.data.subarray(0, file.size));
			file.data = grown;
		}
		file.data.set(data, offset);
		file.size = Math.max(file.size, end);
		return SQLITE_OK;
	}

	truncate(fileId: number, size: number): number {
		const { file } = this.#handle(fileId);
		if (size < file.size) {
			file.data.fill(0, size, file.size);
			file.size = size;
		}
		return SQLITE_OK;
	}

	sync(): number {
		return SQLITE_OK;
	}

	size(fileId: number): number {
		return this.#handle(fileId).file.size;
	}

	lock(fileId: number, level: number): number {
		const { file } = this.#handle(fileId);
		for (const [other, held] of file.locks) {
			if (other === fileId) continue;
			// SHARED waits out a writer that is about to commit; RESERVED allows one writer; EXCLUSIVE needs everyone gone.
			const conflict =
				level === SQLITE_LOCK_SHARED
					? held >= SQLITE_LOCK_PENDING
					: level === SQLITE_LOCK_RESERVED
						? held >= SQLITE_LOCK_RESERVED
						: held > SQLITE_LOCK_NONE;
			if (conflict) return SQLITE_BUSY;
		}
		file.locks.set(fileId, level);
		return SQLITE_OK;
	}

	unlock(fileId: number, level: number): number {
		this.#handle(fileId).file.locks.set(fileId, level);
		return SQLITE_OK;
	}

	checkReserved(fileId: number): boolean {
		const { file } = this.#handle(fileId);
		for (const [other, held] of file.locks) if (other !== fileId && held >= SQLITE_LOCK_RESERVED) return true;
		return false;
	}

	close(fileId: number): number {
		const handle = this.#handle(fileId);
		handle.file.locks.delete(fileId);
		this.#handles.delete(fileId);
		if (handle.deleteOnClose && this.#files.get(handle.name) === handle.file) this.#files.delete(handle.name);
		return SQLITE_OK;
	}

	sectorSize(): number {
		return 4096;
	}

	deviceCharacteristics(): number {
		return SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_POWERSAFE_OVERWRITE;
	}
}
