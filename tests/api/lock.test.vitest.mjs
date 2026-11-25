/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/api/lock.test.vitest.mjs
 *	@Date: 2026-11-25T02:57:30-08:00 (1795604250)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:14-08:00 (1795642214)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The `lock` option of `sqlite.open()` on Node: every kind in one process, the fallback from "beside"
 * to "temp", two processes with each kind, and taking over a lock a killed process left behind.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create, hashed, real } from "../../src/vfs/fs.mts";
import { connection, rejected, sqlite } from "./helpers.mjs";

const CHILD = fileURLToPath(new URL("./lock-child.mjs", import.meta.url));
/** The per-user "temp" lock root. */
const TEMP = join(tmpdir(), `cldmv-sqlite-locks-${process.getuid()}`);

const made = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of made.splice(0)) {
		chmodSync(directory, 0o755);
		rmSync(directory, { recursive: true, force: true });
	}
});

/** A fresh scratch folder, removed after the test. */
function scratch() {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-wasm-lock-"));
	made.push(directory);
	return directory;
}

/** Starts lock-child.mjs; `next()` resolves with each stdout line, `exited` with the exit code or signal. */
function child(...args) {
	const proc = spawn(process.execPath, [CHILD, ...args.map(String)], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = [];
	const waiting = [];
	let buffer = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			const resolve = waiting.shift();
			if (resolve) resolve(line);
			else lines.push(line);
		}
	});
	const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve(code ?? signal)));
	return {
		proc,
		exited,
		next: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(resolve))),
		send: (line) => proc.stdin.write(`${line}\n`)
	};
}

/** The rows of the "db" lock table, read with a plain lock so the check itself takes no row. */
async function rows(path) {
	const db = await sqlite.open(path, { readonly: true, lock: "temp" });
	try {
		return db.prepare("select pid, host from _cldmv_lock").all();
	} finally {
		db.close();
	}
}

/** The lock folder each folder kind uses for `path`. */
function folderOf(kind, path, custom) {
	if (kind === "beside") return `${path}.lock`;
	return hashed(kind === "temp" ? TEMP : custom, path);
}

describe("lock option: one process", () => {
	it("reports and places every kind", async () => {
		const dir = scratch();
		const custom = join(dir, "locks");
		for (const [lock, kind, folder] of [
			["beside", "beside", (path) => `${path}.lock`],
			["temp", "temp", (path) => hashed(TEMP, path)],
			[custom, custom, (path) => hashed(custom, path)]
		]) {
			const path = join(dir, `${kind === custom ? "custom" : kind}.db`);
			const db = await sqlite.open(path, { lock });
			expect(db.info.lock).toBe(kind);
			expect(JSON.parse(readFileSync(join(folder(path), "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
			db.close();
			expect(existsSync(folder(path))).toBe(false);
		}
		const memory = await sqlite.open("lock-memory.db", { storage: "memory", lock: "temp" });
		expect(memory.info.lock).toBe("none");
		memory.close();
	});

	it("keeps a row in _cldmv_lock for the db kind, and no folder", async () => {
		const path = join(scratch(), "row.db");
		const db = await sqlite.open(path, { lock: "db", journal: "delete" });
		expect(db.info.lock).toBe("db");
		expect(db.prepare("select pid, host from _cldmv_lock").all()).toEqual([{ pid: process.pid, host: hostname() }]);
		expect(existsSync(`${path}.lock`)).toBe(false);
		// Another connection of this process isn't a second process: it adds its own row and removes only that one.
		const second = await sqlite.open(path, { lock: "db", journal: "delete", timeout: 0 });
		expect(db.prepare("select count(*) from _cldmv_lock").pluck.get()).toBe(2);
		second.close();
		expect(db.prepare("select count(*) from _cldmv_lock").pluck.get()).toBe(1);
		db.close();
		expect(await rows(path)).toEqual([]);
		// A read-only open only checks.
		const readonly = await sqlite.open(path, { lock: "db", readonly: true });
		expect(readonly.info.lock).toBe("db");
		readonly.close();
		expect(await rows(path)).toEqual([]);
	});

	it("removes stale and foreign rows and keeps going when the close hook fails", async () => {
		const path = join(scratch(), "stale-row.db");
		const setup = await sqlite.open(path, { lock: "temp", journal: "delete" });
		setup.execute("create table _cldmv_lock (pid integer not null, host text not null, started text not null)");
		const dead = spawnDead();
		setup.prepare("insert into _cldmv_lock values (?, ?, 'x')").run(dead, hostname());
		setup.prepare("insert into _cldmv_lock values (?, ?, 'x')").run(1, "another-host");
		setup.close();
		const db = await sqlite.open(path, { lock: "db" });
		expect(db.prepare("select pid from _cldmv_lock").pluck.all()).toEqual([process.pid]);
		connection(db).closing.unshift(() => {
			throw new Error("hook failed");
		});
		db.close();
		expect(db.info.open).toBe(false);
	});

	it("counts a process another user owns as live", async () => {
		const path = join(scratch(), "eperm.db");
		const setup = await sqlite.open(path, { lock: "temp", journal: "delete" });
		setup.execute("create table _cldmv_lock (pid integer not null, host text not null, started text not null)");
		setup.prepare("insert into _cldmv_lock values (?, ?, 'x')").run(424242, hostname());
		setup.close();
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		});
		const error = await rejected(sqlite.open(path, { lock: "db", timeout: 30 }));
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(/process 424242 .*lock "db"/) });
	});

	it("names the lock after the real path, so two paths to one file share it", async () => {
		const dir = scratch();
		const path = join(dir, "target.db");
		const link = join(dir, "link.db");
		writeFileSync(path, "");
		symlinkSync(path, link);
		expect(real(link)).toBe(real(path));
		expect(hashed(TEMP, link)).toBe(hashed(TEMP, path));
		// A missing file resolves through its folder; a missing folder leaves the path as it is.
		expect(real(join(dir, "nothing.db"))).toBe(join(real(dir), "nothing.db"));
		expect(real("/no/such/folder/x.db")).toBe("/no/such/folder/x.db");
		const a = await sqlite.open(path, { lock: "temp", journal: "delete" });
		const b = await sqlite.open(path, { lock: "temp", journal: "delete" });
		a.close();
		expect(existsSync(hashed(TEMP, path))).toBe(true);
		b.close();
		expect(existsSync(hashed(TEMP, path))).toBe(false);
	});

	it("attaches and backs up with a folder lock when the main database uses db", async () => {
		const dir = scratch();
		const db = await sqlite.open(join(dir, "main.db"), { lock: "db" });
		await db.attach(join(dir, "other.db"), "other");
		expect(existsSync(join(dir, "other.db.lock"))).toBe(true);
		await db.detach("other");
		await db.backup(join(dir, "copy.db"));
		db.close();
		expect(await rows(join(dir, "copy.db"))).toEqual([]);
	});

	it("fails clearly when the lock folder can't be made", async () => {
		const dir = scratch();
		const blocker = join(dir, "file");
		writeFileSync(blocker, "");
		const error = await rejected(sqlite.open(join(dir, "x.db"), { lock: join(blocker, "locks") }));
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_CANTOPEN", message: expect.stringMatching(/^cannot lock/) });
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("reports beside for a file the driver opened without prepare", () => {
		expect(create().held("/somewhere/x.db")).toBe("beside");
		create().release("/never/prepared.db");
	});

	it("prepares with the driver's own timeout and the beside lock when given no options", async () => {
		const path = join(scratch(), "direct.db");
		const driver = create({ timeout: 10 });
		const name = await driver.prepare(path);
		expect(driver.held(name)).toBe("beside");
		expect(existsSync(`${path}.lock`)).toBe(true);
		driver.release(name);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it.skipIf(process.getuid?.() === 0)("falls back from beside to temp for a read-only database in a read-only folder", async () => {
		const dir = scratch();
		const path = join(dir, "ro.db");
		const setup = await sqlite.open(path, { journal: "delete" });
		setup.execute("create table t (x); insert into t values (1)");
		setup.close();
		chmodSync(dir, 0o555);
		const db = await sqlite.open(path, { readonly: true });
		expect(db.info.lock).toBe("temp");
		expect(existsSync(hashed(TEMP, path))).toBe(true);
		expect(db.prepare("select x from t").pluck.get()).toBe(1);
		db.close();
		expect(existsSync(hashed(TEMP, path))).toBe(false);
	});
});

/** A pid that has already exited on this host. */
function spawnDead() {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

describe("lock option: two processes", () => {
	for (const kind of ["beside", "temp", "folder"]) {
		it(`${kind}: keeps a second process out, waits for it, and takes over after a kill`, async () => {
			const dir = scratch();
			const lock = kind === "folder" ? join(dir, "locks") : kind;
			const path = join(dir, `${kind}.db`);
			const holder = child(path, lock);
			expect(await holder.next()).toBe(`open ${lock}`);
			const error = await rejected(sqlite.open(path, { lock, timeout: 50 }));
			expect(error).toBeInstanceOf(sqlite.error);
			expect(error).toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(/is locked by another process/) });
			holder.send("close");
			expect(await holder.next()).toBe("closed");
			await holder.exited;

			// Waits up to the timeout for a holder that lets go.
			const brief = child(path, lock, 300);
			expect(await brief.next()).toBe(`open ${lock}`);
			const waited = await sqlite.open(path, { lock, timeout: 10000 });
			expect(waited.info.lock).toBe(lock);
			waited.close();
			await brief.exited;

			// A killed holder leaves its folder behind; the next open takes it over.
			const killed = child(path, lock);
			expect(await killed.next()).toBe(`open ${lock}`);
			killed.proc.kill("SIGKILL");
			await killed.exited;
			const folder = folderOf(kind === "folder" ? "custom" : kind, path, lock);
			expect(existsSync(folder)).toBe(true);
			const taken = await sqlite.open(path, { lock, timeout: 0 });
			expect(JSON.parse(readFileSync(join(folder, "owner.json"), "utf8")).pid).toBe(process.pid);
			taken.close();
		});
	}

	it("db: detects a second process, waits for it, and takes over a killed one's row", async () => {
		const dir = scratch();
		const path = join(dir, "db.db");
		const holder = child(path, "db");
		expect(await holder.next()).toBe("open db");
		for (const readonly of [false, true]) {
			const error = await rejected(sqlite.open(path, { lock: "db", readonly, timeout: 50 }));
			expect(error).toBeInstanceOf(sqlite.error);
			expect(error).toMatchObject({ code: "SQLITE_BUSY", message: expect.stringMatching(new RegExp(`process ${holder.proc.pid} `)) });
		}
		holder.send("close");
		expect(await holder.next()).toBe("closed");
		await holder.exited;

		const brief = child(path, "db", 300);
		expect(await brief.next()).toBe("open db");
		const waited = await sqlite.open(path, { lock: "db", timeout: 10000 });
		waited.close();
		await brief.exited;

		const killed = child(path, "db");
		expect(await killed.next()).toBe("open db");
		killed.proc.kill("SIGKILL");
		await killed.exited;
		expect((await rows(path)).map((row) => row.pid)).toEqual([killed.proc.pid]);
		const taken = await sqlite.open(path, { lock: "db", timeout: 0 });
		expect(taken.prepare("select pid from _cldmv_lock").pluck.all()).toEqual([process.pid]);
		taken.close();
	});
});
