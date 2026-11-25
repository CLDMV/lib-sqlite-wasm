/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/fakes/opfs.mjs
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
 * @fileoverview In-memory stand-ins for the OPFS and Web Locks APIs, so the OPFS driver runs under Node.
 *
 * They follow the browser behaviour the driver depends on: one sync access handle per file at a time
 * (NoModificationAllowedError otherwise), NotFoundError for a missing entry without `create`, TypeMismatchError for
 * the wrong kind of entry, no removing a file that has an open handle, and Web Locks with `ifAvailable` (callback gets
 * null) and `signal` (the request rejects with the signal's reason).
 */

const domerror = (name, message = name) => new DOMException(message, name);

/** One file's bytes. `short` makes the next write report one byte less than asked; `broken` makes handle creation fail. */
export class fakefileentry {
	data = new Uint8Array(0);
	open = false;
	short = false;
	broken = false;
}

/** A FileSystemSyncAccessHandle over a fake file. */
class fakehandle {
	#file;
	closed = false;

	constructor(file) {
		this.#file = file;
	}

	#live() {
		if (this.closed) throw domerror("InvalidStateError", "handle is closed");
		return this.#file;
	}

	read(buffer, { at }) {
		const file = this.#live();
		const part = file.data.subarray(at, at + buffer.length);
		buffer.set(part);
		return part.length;
	}

	write(buffer, { at }) {
		const file = this.#live();
		const length = file.short ? buffer.length - 1 : buffer.length;
		file.short = false;
		const end = at + length;
		if (end > file.data.length) {
			const grown = new Uint8Array(end);
			grown.set(file.data);
			file.data = grown;
		}
		file.data.set(buffer.subarray(0, length), at);
		return length;
	}

	truncate(size) {
		const file = this.#live();
		const next = new Uint8Array(size);
		next.set(file.data.subarray(0, size));
		file.data = next;
	}

	getSize() {
		return this.#live().data.length;
	}

	flush() {
		this.#live();
	}

	close() {
		if (!this.closed) this.#file.open = false;
		this.closed = true;
	}
}

/** A FileSystemFileHandle. */
class fakefile {
	constructor(entry) {
		this.entry = entry;
	}

	async createSyncAccessHandle() {
		if (this.entry.broken) throw new Error("handle creation failed");
		if (this.entry.open) throw domerror("NoModificationAllowedError", "file has an open handle");
		this.entry.open = true;
		return new fakehandle(this.entry);
	}
}

/** A FileSystemDirectoryHandle. `failremove` makes removeEntry reject. */
export class fakedirectory {
	entries = new Map();
	failremove = false;

	async getDirectoryHandle(name, { create = false } = {}) {
		const found = this.entries.get(name);
		if (found instanceof fakedirectory) return found;
		if (found) throw domerror("TypeMismatchError");
		if (!create) throw domerror("NotFoundError");
		const made = new fakedirectory();
		this.entries.set(name, made);
		return made;
	}

	async getFileHandle(name, { create = false } = {}) {
		const found = this.entries.get(name);
		if (found instanceof fakedirectory) throw domerror("TypeMismatchError");
		if (found) return new fakefile(found);
		if (!create) throw domerror("NotFoundError");
		const made = new fakefileentry();
		this.entries.set(name, made);
		return new fakefile(made);
	}

	async removeEntry(name) {
		if (this.failremove) throw new Error("remove failed");
		const found = this.entries.get(name);
		if (!found) throw domerror("NotFoundError");
		if (found.open) throw domerror("NoModificationAllowedError");
		this.entries.delete(name);
	}

	/** Entry names, sorted. */
	names() {
		return [...this.entries.keys()].sort();
	}

	/** A file entry by name. */
	file(name) {
		return this.entries.get(name);
	}
}

/** A LockManager with exclusive locks only. */
export function fakelocks() {
	const held = new Map();
	return {
		held,
		async request(name, options, callback) {
			if (held.has(name)) {
				if (options.ifAvailable) return callback(null);
				await new Promise((resolve, reject) => {
					const queue = held.get(name);
					queue.push(resolve);
					options.signal?.addEventListener("abort", () => {
						queue.splice(queue.indexOf(resolve), 1);
						reject(options.signal.reason);
					});
				});
			} else held.set(name, []);
			try {
				return await callback({ name, mode: "exclusive" });
			} finally {
				const next = held.get(name).shift();
				if (next) next();
				else held.delete(name);
			}
		}
	};
}
