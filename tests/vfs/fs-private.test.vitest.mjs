/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/vfs/fs-private.test.vitest.mjs
 *	@Date: 2026-11-25T11:19:25-08:00 (1795634365)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:18-08:00 (1795642218)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview What the fs driver keeps under os.tmpdir() stays private to the user: unnamed temporary files in a
 * per-process mkdtemp folder, and the per-user root of "temp" locks, which is refused when someone else could reach it.
 * os.tmpdir() points at a fresh folder per test, so nothing here touches the real temp folder.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, tmpdir: vi.fn(real.tmpdir) };
});
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, lstatSync: vi.fn(real.lstatSync) };
});

const realOs = await vi.importActual("node:os");
const realFs = await vi.importActual("node:fs");

const READWRITE_CREATE_DELETE = 0x2 | 0x4 | 0x8;
const READWRITE_CREATE_MAIN = 0x2 | 0x4 | 0x100;
const OK = 0;
const uid = process.getuid();

let nextId = 4_000_000;
const id = () => nextId++;

/** The folder os.tmpdir() returns in the current test. */
let temp;

beforeEach(() => {
	temp = realFs.mkdtempSync(join(realOs.tmpdir(), "sqlite-wasm-private-"));
	vi.mocked(tmpdir).mockReturnValue(temp);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(tmpdir).mockReset().mockImplementation(realOs.tmpdir);
	vi.mocked(lstatSync).mockReset().mockImplementation(realFs.lstatSync);
	chmodSync(temp, 0o700);
	rmSync(temp, { recursive: true, force: true });
});

/** A fresh copy of the driver module (no temporary folder made, no exit handler yet) and the exit handlers it adds. */
async function fresh() {
	vi.resetModules();
	const on = vi.spyOn(process, "on");
	const module = await import("../../src/vfs/fs.mts");
	/** Runs (and unregisters) every exit handler the module registered so far. */
	const exit = () => {
		for (const [event, handler] of on.mock.calls.filter(([event]) => event === "exit")) {
			process.off(event, handler);
			handler();
		}
	};
	return { ...module, exit, exits: () => on.mock.calls.filter(([event]) => event === "exit").length };
}

/** The folders directly in the fake temp folder whose names start with `prefix`. */
const folders = (prefix) => readdirSync(temp).filter((name) => name.startsWith(prefix));

describe("unnamed temporary files", () => {
	it("go in one private folder per process, with mode 0600, and the folder goes at exit", async () => {
		const { create, exit, exits } = await fresh();
		const driver = create();
		expect(folders("sqlite-wasm-")).toEqual([]); // made on first use only
		const [a, b] = [id(), id()];
		expect(driver.open(null, a, READWRITE_CREATE_DELETE)).toBe(OK);
		expect(driver.open(null, b, READWRITE_CREATE_DELETE)).toBe(OK);
		const made = folders("sqlite-wasm-");
		expect(made).toHaveLength(1); // the second file reuses the folder
		const folder = join(temp, made[0]);
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		const files = readdirSync(folder);
		expect(files).toHaveLength(2);
		for (const name of files) expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
		expect(driver.write(a, new Uint8Array([1, 2]), 0)).toBe(OK);
		expect(driver.close(a)).toBe(OK);
		expect(readdirSync(folder)).toHaveLength(1);
		expect(exits()).toBe(1);
		exit();
		expect(folders("sqlite-wasm-")).toEqual([]);
		expect(driver.close(b)).toBe(OK); // already gone with the folder; closing is still fine
	});

	it("makes a new private folder when the old one was removed", async () => {
		const { create, exit } = await fresh();
		const driver = create();
		const first = id();
		expect(driver.open(null, first, READWRITE_CREATE_DELETE)).toBe(OK);
		expect(driver.close(first)).toBe(OK);
		const [old] = folders("sqlite-wasm-");
		rmSync(join(temp, old), { recursive: true });
		const second = id();
		expect(driver.open(null, second, READWRITE_CREATE_DELETE)).toBe(OK);
		const now = folders("sqlite-wasm-");
		expect(now).toHaveLength(1);
		expect(now[0]).not.toBe(old);
		expect(driver.close(second)).toBe(OK);
		exit();
		expect(folders("sqlite-wasm-")).toEqual([]);
	});
});

describe("the temp lock root", () => {
	const ROOT = `cldmv-sqlite-locks-${uid}`;

	/** A database path in its own folder (outside the fake temp folder's lock root). */
	const database = () => join(temp, "db", "a.db");

	beforeEach(() => mkdirSync(join(temp, "db")));

	it("is per user, private, and found again by another driver of the same user", async () => {
		const { create, hashed } = await fresh();
		const path = database();
		const driver = create({ timeout: 0 });
		const name = await driver.prepare(path, { lock: "temp" });
		expect(driver.held(name)).toBe("temp");
		const root = join(temp, ROOT);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		const lock = hashed(root, path);
		expect(statSync(lock).mode & 0o777).toBe(0o700);
		expect(statSync(join(lock, "owner.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);

		// Another module instance stands in for another process of the same user: same root, so it sees the lock.
		const other = await fresh();
		await expect(other.create({ timeout: 0 }).prepare(path, { lock: "temp" })).rejects.toMatchObject({ code: "SQLITE_BUSY" });

		driver.release(name);
		expect(readdirSync(root)).toEqual([]);
	});

	it("keeps using an existing private root", async () => {
		mkdirSync(join(temp, ROOT), { mode: 0o700 });
		const { create } = await fresh();
		const driver = create({ timeout: 0 });
		const name = await driver.prepare(database(), { lock: "temp" });
		driver.release(name);
	});

	it("is refused when it is a symbolic link", async () => {
		const elsewhere = join(temp, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, join(temp, ROOT));
		const { create } = await fresh();
		await expect(create({ timeout: 0 }).prepare(database(), { lock: "temp" })).rejects.toThrow(
			/refusing the temp lock folder .* is a symbolic link/
		);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("is refused when it isn't a directory", async () => {
		const { create } = await fresh();
		// Replaced by something else between creating and checking it.
		vi.mocked(lstatSync).mockImplementationOnce(() => ({ isSymbolicLink: () => false, isDirectory: () => false, uid, mode: 0o100600 }));
		await expect(create({ timeout: 0 }).prepare(database(), { lock: "temp" })).rejects.toThrow(/is not a directory/);
	});

	it("is refused when another user owns it", async () => {
		const { create } = await fresh();
		vi.mocked(lstatSync).mockImplementationOnce(() => ({
			isSymbolicLink: () => false,
			isDirectory: () => true,
			uid: uid + 1,
			mode: 0o40700
		}));
		await expect(create({ timeout: 0 }).prepare(database(), { lock: "temp" })).rejects.toThrow(
			new RegExp(`belongs to uid ${uid + 1}, not ${uid}`)
		);
	});

	it.each([
		[0o770, "770"],
		[0o707, "707"]
	])("is refused when other users can write to it (mode %o)", async (mode, shown) => {
		mkdirSync(join(temp, ROOT));
		chmodSync(join(temp, ROOT), mode);
		const { create } = await fresh();
		await expect(create({ timeout: 0 }).prepare(database(), { lock: "temp" })).rejects.toThrow(
			new RegExp(`writable by other users \\(mode ${shown}\\)`)
		);
	});

	it("keeps the shared name, unchecked, where there are no uids (Windows)", async () => {
		const { create, temporaryLocks } = await fresh();
		const getuid = process.getuid;
		process.getuid = undefined;
		try {
			expect(temporaryLocks()).toBe(join(temp, "cldmv-sqlite-locks"));
			const driver = create({ timeout: 0 });
			const name = await driver.prepare(database(), { lock: "temp" });
			expect(readdirSync(join(temp, "cldmv-sqlite-locks"))).toHaveLength(1);
			driver.release(name);
		} finally {
			process.getuid = getuid;
		}
	});

	it("only changes the modes of temp locks: a beside lock keeps the umask's", async () => {
		const { create } = await fresh();
		const path = database();
		const driver = create({ timeout: 0 });
		const file = id();
		expect(driver.open(path, file, READWRITE_CREATE_MAIN)).toBe(OK);
		// What a plain mkdir / writeFile gets under this process's umask.
		mkdirSync(join(temp, "probe"));
		writeFileSync(join(temp, "probe", "file"), "");
		expect(statSync(`${path}.lock`).mode & 0o777).toBe(statSync(join(temp, "probe")).mode & 0o777);
		expect(statSync(`${path}.lock/owner.json`).mode & 0o777).toBe(statSync(join(temp, "probe", "file")).mode & 0o777);
		expect(driver.close(file)).toBe(OK);
	});
});
