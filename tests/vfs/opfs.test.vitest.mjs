/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/opfs.test.vitest.mjs
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

import { afterEach, describe, expect, it, vi } from "vitest";
import opfs, { create, normalize } from "../../src/vfs/opfs.mts";
import { fakedirectory, fakelocks } from "../fakes/opfs.mjs";

const OK = 0;
const SHORT_READ = 522;
const IOERR_WRITE = 778;
const DELETE_NOENT = 5898;
const MAIN_DB = 0x100 | 0x2 | 0x4;
const MAIN_JOURNAL = 0x800 | 0x2 | 0x4;
const WAL = 0x80000 | 0x2 | 0x4;
const TEMP_JOURNAL = 0x1000 | 0x2 | 0x4;

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A driver over a fresh fake root, with its own fake lock manager unless one is given. */
function setup(extra = {}) {
	const root = new fakedirectory();
	const locks = fakelocks();
	return { root, locks, driver: create({ root, locks, ...extra }) };
}

describe("normalize", () => {
	it("makes one canonical name per path", () => {
		expect(normalize("app.db")).toBe("/app.db");
		expect(normalize("//a/./b//app.db")).toBe("/a/b/app.db");
		expect(opfs.normalize).toBe(normalize);
		expect(opfs.create).toBe(create);
	});

	it("refuses empty paths and ..", () => {
		expect(() => normalize("")).toThrow(/invalid OPFS path/);
		expect(() => normalize("/./")).toThrow(/invalid OPFS path/);
		expect(() => normalize("a/../b")).toThrow(expect.objectContaining({ code: "SQLITE_CANTOPEN", number: 14 }));
	});
});

describe("prepare / release", () => {
	it("opens the database, journal and WAL in nested folders and removes empty companions on release", async () => {
		const { root, driver } = setup();
		expect(await driver.prepare("data/app.db")).toBe("/data/app.db");
		const folder = await root.getDirectoryHandle("data");
		expect(folder.names()).toEqual(["app.db", "app.db-journal", "app.db-wal"]);

		expect(driver.open("/data/app.db-wal", 1, WAL)).toBe(OK);
		expect(driver.write(1, new Uint8Array([1, 2]), 0)).toBe(OK);
		expect(driver.close(1)).toBe(OK);

		await driver.release("data/app.db");
		expect(folder.names()).toEqual(["app.db", "app.db-wal"]);
		expect(folder.file("app.db-wal").open).toBe(false);
		// Releasing twice, or something never prepared, is a no-op.
		await driver.release("data/app.db");
		await driver.release("other.db");
	});

	it("refuses a second prepare of the same database on the same driver", async () => {
		const { driver } = setup();
		await driver.prepare("app.db");
		await expect(driver.prepare("/app.db")).rejects.toThrow(/open in another tab/);
	});

	it("fails fast while another driver (another tab) holds the lock, and succeeds after release", async () => {
		const { root, locks, driver } = setup();
		const other = create({ root, locks });
		await driver.prepare("app.db");
		await expect(other.prepare("app.db")).rejects.toMatchObject({ code: "SQLITE_BUSY", number: 5 });
		await driver.release("app.db");
		await expect(other.prepare("app.db")).resolves.toBe("/app.db");
	});

	it("waits for the lock when asked to", async () => {
		const { root, locks, driver } = setup();
		const patient = create({ root, locks, wait: Infinity });
		await driver.prepare("app.db");
		const waiting = patient.prepare("app.db");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await driver.release("app.db");
		await expect(waiting).resolves.toBe("/app.db");
	});

	it("gives up after the wait time", async () => {
		const { root, locks, driver } = setup();
		const brief = create({ root, locks, wait: 20 });
		await driver.prepare("app.db");
		const error = await brief.prepare("app.db").catch((thrown) => thrown);
		expect(error.message).toMatch(/open in another tab/);
		expect(error.cause.name).toBe("TimeoutError");
	});

	it("reports a lock manager failure as busy with the cause", async () => {
		const failing = { request: () => Promise.reject(new Error("locks broken")) };
		const driver = create({ root: new fakedirectory(), locks: failing });
		const error = await driver.prepare("app.db").catch((thrown) => thrown);
		expect(error.code).toBe("SQLITE_BUSY");
		expect(error.cause.message).toBe("locks broken");
	});

	it("maps an existing sync handle (no Web Locks) to busy and releases what it opened", async () => {
		const root = new fakedirectory();
		const first = create({ root, locks: null });
		const second = create({ root, locks: null });
		await first.prepare("app.db");
		const error = await second.prepare("app.db").catch((thrown) => thrown);
		expect(error.code).toBe("SQLITE_BUSY");
		expect(error.cause.name).toBe("NoModificationAllowedError");
	});

	it("rethrows other handle errors and drops the lock", async () => {
		const { root, locks, driver } = setup();
		const file = await root.getFileHandle("app.db-wal", { create: true });
		file.entry.broken = true;
		await expect(driver.prepare("app.db")).rejects.toThrow("handle creation failed");
		expect(locks.held.size).toBe(0);
		expect((await root.getFileHandle("app.db")).entry.open).toBe(false);
	});

	it("refuses a missing database when create is false", async () => {
		const { driver } = setup();
		const error = await driver.prepare("missing.db", { create: false }).catch((thrown) => thrown);
		expect(error.message).toMatch(/does not exist/);
		expect(error.code).toBe("SQLITE_CANTOPEN");
	});

	it("rethrows other lookup errors (a folder where the file should be)", async () => {
		const { root, driver } = setup();
		await root.getDirectoryHandle("app.db", { create: true });
		await expect(driver.prepare("app.db")).rejects.toMatchObject({ name: "TypeMismatchError" });
	});

	it("ignores a failure removing an empty companion", async () => {
		const { root, driver } = setup();
		await driver.prepare("app.db");
		root.failremove = true;
		await driver.release("app.db");
		expect(root.names()).toEqual(["app.db", "app.db-journal", "app.db-wal"]);
	});

	it("lets a reopen right after release wait for the release to finish", async () => {
		const { driver } = setup();
		await driver.prepare("app.db");
		const released = driver.release("app.db");
		// Still releasing: the same promise comes back, and prepare waits for it.
		expect(driver.release("app.db")).toBe(released);
		await expect(driver.prepare("app.db")).resolves.toBe("/app.db");
	});
});

describe("ambient browser APIs", () => {
	it("uses navigator.storage and navigator.locks when no options are given", async () => {
		const root = new fakedirectory();
		const locks = fakelocks();
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root }, locks });
		const driver = create();
		await driver.prepare("app.db");
		expect(root.names()).toContain("app.db");
		expect(locks.held.has("sqlite-wasm:/app.db")).toBe(true);
		await driver.release("app.db");
	});

	it("reports missing OPFS", async () => {
		vi.stubGlobal("navigator", undefined);
		await expect(create().prepare("app.db")).rejects.toThrow(/OPFS is not available/);
		vi.stubGlobal("navigator", {});
		await expect(create().prepare("app.db")).rejects.toThrow(/OPFS is not available/);
	});
});

describe("VFS methods", () => {
	it("reads, writes, truncates and syncs prepared files", async () => {
		const { driver } = setup();
		await driver.prepare("app.db");
		expect(driver.open("/app.db", 1, MAIN_DB)).toBe(OK);
		expect(driver.write(1, new Uint8Array([1, 2, 3, 4]), 0)).toBe(OK);
		expect(driver.size(1)).toBe(4);
		const target = new Uint8Array(4).fill(9);
		expect(driver.read(1, target, 2)).toBe(SHORT_READ);
		expect(target).toEqual(new Uint8Array([3, 4, 0, 0]));
		expect(driver.read(1, target, 0)).toBe(OK);
		expect(target).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(driver.truncate(1, 1)).toBe(OK);
		expect(driver.size(1)).toBe(1);
		expect(driver.sync(1, 0)).toBe(OK);
		expect(driver.lock(1, 4)).toBe(OK);
		expect(driver.unlock(1, 0)).toBe(OK);
		expect(driver.checkReserved(1)).toBe(false);
		expect(driver.sectorSize(1)).toBe(4096);
		expect(driver.deviceCharacteristics(1)).toBe(0x800);
		expect(driver.fullPathname("app.db")).toBe("/app.db");
		expect(driver.close(1)).toBe(OK);
	});

	it("reports a short write", async () => {
		const { root, driver } = setup();
		await driver.prepare("app.db");
		driver.open("/app.db", 1, MAIN_DB);
		root.file("app.db").short = true;
		expect(driver.write(1, new Uint8Array([1, 2]), 0)).toBe(IOERR_WRITE);
	});

	it("treats empty companions as absent and truncates them on delete", async () => {
		const { driver } = setup();
		await driver.prepare("app.db");
		expect(driver.access("/app.db-journal", 0)).toBe(false);
		driver.open("/app.db-journal", 2, MAIN_JOURNAL);
		driver.write(2, new Uint8Array([1]), 0);
		expect(driver.access("/app.db-journal", 0)).toBe(true);
		expect(driver.delete("/app.db-journal", false)).toBe(OK);
		expect(driver.access("/app.db-journal", 0)).toBe(false);
		driver.write(2, new Uint8Array([1]), 0);
		expect(driver.delete("/app.db-journal", true)).toBe(OK);
		expect(driver.size(2)).toBe(0);
	});

	it("refuses to open an unprepared database, journal or WAL", () => {
		const { driver } = setup();
		expect(() => driver.open("/app.db", 1, MAIN_DB)).toThrow(/was not prepared/);
		expect(() => driver.open("/app.db-journal", 1, MAIN_JOURNAL)).toThrow(/was not prepared/);
		expect(() => driver.open("/app.db-wal", 1, WAL)).toThrow(/was not prepared/);
	});

	it("keeps temp and other scratch files in memory", () => {
		const { driver } = setup();
		expect(driver.open(null, 7, 0x200 | 0x2)).toBe(OK);
		expect(driver.open("/app.db-mj01", 8, TEMP_JOURNAL)).toBe(OK);
		expect(driver.write(8, new Uint8Array([5, 6]), 0)).toBe(OK);
		expect(driver.access("/app.db-mj01", 0)).toBe(true);
		expect(driver.size(8)).toBe(2);
		const target = new Uint8Array(2);
		expect(driver.read(8, target, 0)).toBe(OK);
		expect(target).toEqual(new Uint8Array([5, 6]));
		expect(driver.truncate(8, 0)).toBe(OK);
		expect(driver.sync(8, 0)).toBe(OK);
		expect(driver.lock(8, 1)).toBe(OK);
		expect(driver.checkReserved(8)).toBe(false);
		expect(driver.unlock(8, 0)).toBe(OK);
		expect(driver.deviceCharacteristics(8)).toBe(0x200 | 0x1000);
		expect(driver.close(8)).toBe(OK);
		expect(driver.delete("/app.db-mj01", false)).toBe(OK);
		expect(driver.delete("/app.db-mj01", false)).toBe(DELETE_NOENT);
		expect(driver.close(7)).toBe(OK);
	});
});
