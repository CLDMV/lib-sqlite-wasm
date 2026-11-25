/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/vfs/fs-race.test.vitest.mjs
 *	@Date: 2026-11-25T01:49:24-08:00 (1795600164)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T11:21:02-08:00 (1795634462)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The owner lock's race paths: another process changing the lock directory between two of our steps. Two real
 * processes can't hit those windows on demand, so node:fs is wrapped and the other process's step is played in.
 */
import { existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "../../src/vfs/fs.mts";
import { cleanup, plantLock, scratch } from "./fs-helpers.mjs";

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, renameSync: vi.fn(real.renameSync), readFileSync: vi.fn(real.readFileSync), openSync: vi.fn(real.openSync) };
});

const READWRITE_CREATE_MAIN = 0x2 | 0x4 | 0x100;
const READWRITE_CREATE = 0x2 | 0x4;
const [OK, CANTOPEN] = [0, 14];

let nextId = 3_000_000;
const id = () => nextId++;

/** An fs error with `code`. */
const failure = (code) => Object.assign(new Error(code), { code });

/** The real implementations behind the mocks. */
const real = await vi.importActual("node:fs");

afterEach(() => {
	vi.mocked(renameSync).mockReset().mockImplementation(real.renameSync);
	vi.mocked(readFileSync).mockReset().mockImplementation(real.readFileSync);
	vi.mocked(openSync).mockReset().mockImplementation(real.openSync);
	cleanup();
});

/** Opens `path` as a main database, closes it again and checks that the lock went with it. */
function openAndClose(path) {
	const driver = create({ timeout: 0 });
	const file = id();
	expect(driver.open(path, file, READWRITE_CREATE_MAIN)).toBe(OK);
	expect(JSON.parse(real.readFileSync(`${path}.lock/owner.json`, "utf8")).pid).toBe(process.pid);
	driver.close(file);
	expect(existsSync(`${path}.lock`)).toBe(false);
}

describe("owner lock races", () => {
	it("retries when the lock disappears between our attempt and reading its owner", () => {
		const path = join(scratch(), "db");
		// Our rename sees a lock that its owner releases right after.
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw failure("EEXIST");
		});
		openAndClose(path);
	});

	it("retries when the stale lock is removed under a takeover in progress", () => {
		const path = join(scratch(), "db");
		plantLock(`${path}.lock`);
		vi.mocked(renameSync)
			.mockImplementationOnce(real.renameSync) // our attempt: the stale lock is there
			.mockImplementationOnce((from) => {
				// Another taker removes the stale lock before our reap marker lands in it.
				real.rmSync(`${path}.lock`, { recursive: true });
				rmSync(from, { recursive: true });
				throw failure("ENOENT");
			});
		openAndClose(path);
	});

	it("backs off when a new owner replaced the stale one before our takeover started", () => {
		const path = join(scratch(), "db");
		const stale = plantLock(`${path}.lock`);
		const fresh = JSON.stringify({ ...stale, started: "a different lock" });
		vi.mocked(readFileSync)
			.mockImplementationOnce(real.readFileSync) // the stale owner
			.mockImplementationOnce(() => fresh); // checked again after claiming the reap marker
		const driver = create({ timeout: 0 });
		const file = id();
		expect(driver.open(path, file, READWRITE_CREATE_MAIN)).toBe(OK);
		// Our reap marker was withdrawn; the takeover then went ahead on the next round.
		expect(readdirSync(`${path}.lock`)).toEqual(["owner.json"]);
		driver.close(file);
	});

	it("carries on when another taker removed the stale lock first", () => {
		const path = join(scratch(), "db");
		plantLock(`${path}.lock`);
		vi.mocked(renameSync)
			.mockImplementationOnce(real.renameSync) // our attempt
			.mockImplementationOnce(real.renameSync) // our reap marker
			.mockImplementationOnce(() => {
				real.rmSync(`${path}.lock`, { recursive: true });
				throw failure("ENOENT");
			});
		openAndClose(path);
	});

	it("reports an error while removing a stale lock", () => {
		const path = join(scratch(), "db");
		plantLock(`${path}.lock`);
		vi.mocked(renameSync)
			.mockImplementationOnce(real.renameSync)
			.mockImplementationOnce(real.renameSync)
			.mockImplementationOnce(() => {
				throw failure("EACCES");
			});
		expect(() => create({ timeout: 0 }).open(path, id(), READWRITE_CREATE_MAIN)).toThrow(/EACCES/);
	});
});

describe("creating files", () => {
	/** How often the driver opened `directory` to fsync it (only after creating a file in it). */
	const syncs = (directory) => vi.mocked(openSync).mock.calls.filter(([path, flags]) => path === directory && flags === "r").length;

	it("knows from the open itself whether it created the file", () => {
		const dir = scratch();
		const path = join(dir, "f");
		const driver = create({ timeout: 0 });
		const first = id();
		expect(driver.open(path, first, READWRITE_CREATE)).toBe(OK);
		expect(syncs(dir)).toBe(1);
		driver.close(first);
		vi.mocked(openSync).mockClear();
		// Already there: opened without creating, so the folder needs no fsync.
		const second = id();
		expect(driver.open(path, second, READWRITE_CREATE)).toBe(OK);
		expect(syncs(dir)).toBe(0);
		driver.close(second);
	});

	it("creates the file again when it is deleted between finding it and opening it", () => {
		const dir = scratch();
		const path = join(dir, "f");
		writeFileSync(path, "x");
		vi.mocked(openSync)
			.mockImplementationOnce(() => {
				throw failure("EEXIST");
			})
			.mockImplementationOnce(() => {
				real.rmSync(path);
				throw failure("ENOENT");
			});
		const driver = create({ timeout: 0 });
		const file = id();
		expect(driver.open(path, file, READWRITE_CREATE)).toBe(OK);
		expect(syncs(dirname(path))).toBe(1);
		expect(driver.size(file)).toBe(0);
		driver.close(file);
	});

	it("can't open a file in a missing folder", () => {
		const path = join(scratch(), "missing", "f");
		expect(create({ timeout: 0 }).open(path, id(), READWRITE_CREATE)).toBe(CANTOPEN);
	});

	it("reports other errors while creating", () => {
		vi.mocked(openSync).mockImplementationOnce(() => {
			throw failure("EACCES");
		});
		expect(() => create({ timeout: 0 }).open(join(scratch(), "f"), id(), READWRITE_CREATE)).toThrow(/EACCES/);
	});
});
