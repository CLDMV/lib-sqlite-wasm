/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/core/router.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:12-08:00 (1795642212)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview A VFS driver that routes each file to the storage driver of the database it belongs to.
 *
 * Every connection in the process shares one module instance (see src/api/runtime.mts), and an instance has exactly
 * one VFS. The router is that VFS's driver. A connection registers its database name with the driver that should
 * store it before calling sqlite3_open_v2(); SQLite's own files for that database (`<name>-journal`, `<name>-wal`,
 * `<name>-mj…` super-journals) are matched by prefix. Files SQLite opens without a name (temporary files) and names no
 * connection registered go to the fallback driver, which is the shared memory driver.
 */
import { SQLITE_OK } from "./constants.mts";
import type { VfsDriver } from "./vfs-imports.mts";

/** A registered name, the key of the storage it belongs to, and how many registrations hold it. */
interface Entry {
	driver: VfsDriver;
	key: unknown;
	count: number;
}

/** Thrown by `register()` when a name is already registered with a different driver. */
export class RouteConflict extends Error {}

/** Routes VFS calls by file name (on open) and by file id (afterwards). */
export class VfsRouter implements VfsDriver {
	readonly #fallback: VfsDriver;
	readonly #names = new Map<string, Entry>();
	readonly #files = new Map<number, VfsDriver>();

	constructor(fallback: VfsDriver) {
		this.#fallback = fallback;
	}

	/**
	 * Sends `name` (and the driver's full pathname for it) to `driver` until the returned function is called. Names are
	 * reference counted, so two connections to the same database can each register and release it.
	 *
	 * `key` says which drivers are interchangeable for one name; it defaults to the driver itself. Drivers of one
	 * storage kind that keep their per-file state process-wide (the node-fs driver) pass the kind, so two connections
	 * to one file can each bring their own driver object; the name stays routed to the first one.
	 */
	register(name: string, driver: VfsDriver, key: unknown = driver): () => void {
		const names = [...new Set([name, driver.fullPathname(name)])];
		for (const each of names) {
			const entry = this.#names.get(each);
			if (entry && entry.key !== key) throw new RouteConflict(`"${each}" is already open with another storage driver`);
		}
		for (const each of names) {
			const entry = this.#names.get(each);
			if (entry) entry.count++;
			else this.#names.set(each, { driver, key, count: 1 });
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const each of names) {
				const entry = this.#names.get(each) as Entry;
				if (--entry.count === 0) this.#names.delete(each);
			}
		};
	}

	/** The driver for a file name: an exact match, else the longest registered name followed by "-", else the fallback. */
	route(name: string): VfsDriver {
		const exact = this.#names.get(name);
		if (exact) return exact.driver;
		let best: string | undefined;
		for (const registered of this.#names.keys()) {
			if (name.length > registered.length && name.startsWith(registered) && name[registered.length] === "-") {
				if (best === undefined || registered.length > best.length) best = registered;
			}
		}
		return best === undefined ? this.#fallback : (this.#names.get(best) as Entry).driver;
	}

	#file(fileId: number): VfsDriver {
		return this.#files.get(fileId) as VfsDriver;
	}

	open(name: string | null, fileId: number, flags: number): number {
		const driver = name === null ? this.#fallback : this.route(name);
		const rc = driver.open(name, fileId, flags);
		if (rc === SQLITE_OK) this.#files.set(fileId, driver);
		return rc;
	}

	delete(name: string, syncDir: boolean): number {
		return this.route(name).delete(name, syncDir);
	}

	access(name: string, flags: number): boolean {
		return this.route(name).access(name, flags);
	}

	fullPathname(name: string): string {
		return this.route(name).fullPathname(name);
	}

	read(fileId: number, target: Uint8Array, offset: number): number {
		return this.#file(fileId).read(fileId, target, offset);
	}

	write(fileId: number, data: Uint8Array, offset: number): number {
		return this.#file(fileId).write(fileId, data, offset);
	}

	truncate(fileId: number, size: number): number {
		return this.#file(fileId).truncate(fileId, size);
	}

	sync(fileId: number, flags: number): number {
		return this.#file(fileId).sync(fileId, flags);
	}

	size(fileId: number): number {
		return this.#file(fileId).size(fileId);
	}

	lock(fileId: number, level: number): number {
		return this.#file(fileId).lock(fileId, level);
	}

	unlock(fileId: number, level: number): number {
		return this.#file(fileId).unlock(fileId, level);
	}

	checkReserved(fileId: number): boolean {
		return this.#file(fileId).checkReserved(fileId);
	}

	close(fileId: number): number {
		const driver = this.#file(fileId);
		this.#files.delete(fileId);
		return driver.close(fileId);
	}

	sectorSize(fileId: number): number {
		return this.#file(fileId).sectorSize(fileId);
	}

	deviceCharacteristics(fileId: number): number {
		return this.#file(fileId).deviceCharacteristics(fileId);
	}
}
