/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/api/database.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:54-08:00 (1795600254)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:14-08:00 (1795642214)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import { collect } from "../../src/api/statement.mts";
import { MemoryDriver } from "../../src/vfs/memory.mts";
import { install, sharedMemory } from "../../src/vfs/registry.mts";
import { connection, files, memory, rejected, sqlite, thrown, unique } from "./helpers.mjs";

const restore = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
});

describe("database", () => {
	it("has every alias as the same function", async () => {
		const db = await memory();
		expect(db.prep).toBe(db.prepare);
		expect(db.exec).toBe(db.execute);
		expect(db.tx).toBe(db.transaction);
		expect(db.ckpt).toBe(db.checkpoint);
		expect(db.fn.agg).toBe(db.fn.aggregate);
		expect(Object.isFrozen(db.fn) && Object.isFrozen(db.pragma) && Object.isFrozen(db.info)).toBe(true);
		db.close();
	});

	it("prepare() takes exactly one statement", async () => {
		const db = await memory();
		expect(db.prepare("select 1 -- trailing comment\n  ").pluck.get()).toBe(1);
		expect(db.prepare("select 2;").pluck.get()).toBe(2);
		expect(() => db.prepare("select 1; select 2")).toThrow(/more than one statement/);
		expect(() => db.prepare("  -- nothing")).toThrow(/no statement/);
		expect(() => db.prepare("")).toThrow(RangeError);
		expect(thrown(() => db.prepare("select 1; selec 2"))).toMatchObject({ code: "SQLITE_ERROR", sql: "select 1; selec 2" });
		expect(thrown(() => db.prepare("select * from missing"))).toMatchObject({
			code: "SQLITE_ERROR",
			number: 1,
			message: "no such table: missing"
		});
		expect(() => db.prepare(42)).toThrow(/the SQL must be a string/);
		db.close();
	});

	it("execute() runs a script and returns the database", async () => {
		const db = await memory();
		expect(db.execute("create table t (x); insert into t values (1); select * from t; -- done")).toBe(db);
		expect(db.exec("insert into t values (2)").prepare("select count(*) from t").pluck.get()).toBe(2);
		expect(db.execute("")).toBe(db);
		const error = thrown(() => db.execute("insert into t values (3);\n insert into nowhere values (4)"));
		expect(error).toMatchObject({ code: "SQLITE_ERROR", sql: "insert into t values (3);\n insert into nowhere values (4)" });
		const step = thrown(() => db.execute("create table u (x not null); insert into u values (null)"));
		expect(step).toMatchObject({ code: "SQLITE_CONSTRAINT_NOTNULL", number: 1299, sql: "insert into u values (null)" });
		expect(() => db.execute(null)).toThrow(TypeError);
		db.close();
	});

	it("pragma.get / set / all", async () => {
		const db = await memory();
		db.execute("create table t (a integer, b text)");
		expect(db.pragma.get("user_version")).toBe(0);
		expect(db.pragma.set("user_version", 7)).toBeUndefined();
		expect(db.pragma.get("main.user_version")).toBe(7);
		expect(db.pragma.set("user_version", 8n)).toBeUndefined();
		expect(db.pragma.get("user_version")).toBe(8);
		expect(db.pragma.set("foreign_keys", false)).toBeUndefined();
		expect(db.pragma.get("foreign_keys")).toBe(0);
		db.pragma.set("foreign_keys", true);
		expect(db.pragma.set("cache_size", -2000)).toBeUndefined();
		expect(db.pragma.set("journal_mode", "wal")).toBe("wal");
		expect(db.pragma.get("optimize")).toBeUndefined();
		expect(db.pragma.all("table_info", "t").map((column) => column.name)).toEqual(["a", "b"]);
		expect(db.pragma.all("table_info", "it's")).toEqual([]);
		expect(db.pragma.all("database_list")[0]).toMatchObject({ name: "main" });
		for (const name of ["user_version; drop table t", "1abc", "a.b.c", "", 5])
			expect(() => db.pragma.get(name)).toThrow(/is not a pragma name/);
		for (const value of [Number.NaN, Infinity, null, {}, undefined])
			expect(() => db.pragma.set("user_version", value)).toThrow(/a pragma value must be/);
		db.close();
	});

	it("attaches and detaches databases on the same storage", async () => {
		const db = await memory();
		const other = unique("attached");
		await db.attach(other, "other");
		db.execute("create table other.t (x); insert into other.t values (1)");
		expect(db.pragma.get("other.journal_mode")).toBe("wal");
		expect(files(other)).toContain(`${other}-wal`);
		await db.detach("other");
		expect(() => db.execute("select * from other.t")).toThrow(/no such table/);
		const reopened = await memory(other);
		expect(reopened.prepare("select x from t").pluck.all()).toEqual([1]);
		reopened.close();

		await db.attach(":memory:", "scratch");
		db.execute("create table scratch.s (x)");
		await db.detach("scratch");
		// A database attached with plain SQL can be detached too.
		db.execute("attach database ':memory:' as raw");
		await db.detach("raw");
		db.close();
	});

	it("attach reports failures and releases what it claimed", async () => {
		const db = await memory();
		await db.attach(unique(), "one");
		const again = unique("again");
		expect(await rejected(db.attach(again, "one"))).toMatchObject({ code: "SQLITE_ERROR", message: "database one is already in use" });
		// The failed attach released its claim on `again`.
		await db.attach(again, "two");
		expect(await rejected(db.attach(1, "x"))).toBeInstanceOf(TypeError);
		expect(await rejected(db.attach("x.db", 1))).toBeInstanceOf(TypeError);
		expect(await rejected(db.detach("nothing"))).toMatchObject({ code: "SQLITE_ERROR", message: "no such database: nothing" });
		expect(await rejected(db.detach(1))).toBeInstanceOf(TypeError);
		db.close();
		expect(await rejected(db.attach(unique(), "late"))).toMatchObject({ code: "SQLITE_MISUSE" });
	});

	it("attach can use another storage and notices a close while it waits", async () => {
		const driver = new MemoryDriver();
		const previous = install("fs", async () => ({ create: () => driver }));
		restore.push(() => install("fs", previous));
		const db = await memory();
		const name = unique("elsewhere");
		await db.attach(name, "elsewhere", { storage: "fs" });
		db.execute("create table elsewhere.t (x)");
		expect(driver.files()).toContain(name);
		const pending = db.attach(unique(), "late");
		db.close();
		expect(await rejected(pending)).toMatchObject({ code: "SQLITE_MISUSE" });
	});

	it("attaches read-only to a read-only connection", async () => {
		const name = unique("ro-main");
		const other = unique("ro-other");
		(await memory(name)).execute("create table m (x)").close();
		(await memory(other)).execute("create table t (x); insert into t values (5)").close();
		const db = await memory(name, { readonly: true });
		await db.attach(other, "other");
		expect(db.prepare("select x from other.t").pluck.get()).toBe(5);
		expect(thrown(() => db.execute("insert into other.t values (6)"))).toMatchObject({ code: "SQLITE_READONLY" });
		db.close();
	});

	it("backs up into another file", async () => {
		const db = await memory();
		db.execute("create table t (x); insert into t values ('copied')");
		const target = unique("backup");
		await db.backup(target);
		expect(files(target)).toEqual([target]);
		const copy = await memory(target);
		expect(copy.prepare("select x from t").pluck.get()).toBe("copied");
		copy.close();

		await db.attach(unique(), "side");
		db.execute("create table side.s (y); insert into side.s values ('side')");
		const sideCopy = unique("side-backup");
		await db.backup(sideCopy, { schema: "side", storage: "memory" });
		const side = await memory(sideCopy);
		expect(side.prepare("select y from s").pluck.get()).toBe("side");
		side.close();
		db.close();
	});

	it("reports backup failures", async () => {
		const db = await memory();
		db.execute("create table t (x)");
		expect(await rejected(db.backup(unique(), { schema: "nope" }))).toMatchObject({
			code: "SQLITE_ERROR",
			message: "unknown database nope"
		});
		expect(await rejected(db.backup(unique(), { schema: 5 }))).toBeInstanceOf(TypeError);
		// A WAL destination with a different page size can't take the copy.
		const target = unique("pagesize");
		const existing = await memory(target, { journal: "delete" });
		existing.execute("pragma page_size = 8192; create table other (y)").close();
		expect(await rejected(db.backup(target))).toMatchObject({ code: "SQLITE_READONLY" });
		const pending = db.backup(unique());
		db.close();
		expect(await rejected(pending)).toMatchObject({ code: "SQLITE_MISUSE" });
		expect(await rejected(db.backup(unique()))).toMatchObject({ code: "SQLITE_MISUSE" });
	});

	it("serializes to the bytes of an SQLite file", async () => {
		const db = await memory();
		db.execute("create table t (x); insert into t values (42)");
		const bytes = db.serialize();
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(bytes.subarray(0, 16))).toBe("SQLite format 3\0");
		expect(bytes.length % 4096).toBe(0);
		// Write the bytes to a file and open it.
		const name = unique("restored");
		const driver = sharedMemory();
		driver.open(name, 1e9, 6);
		driver.write(1e9, bytes, 0);
		driver.close(1e9);
		const restored = await memory(name);
		expect(restored.prepare("select x from t").pluck.get()).toBe(42);
		restored.close();

		const fresh = await memory();
		expect(fresh.serialize("main").length).toBe(4096);
		expect(thrown(() => fresh.serialize("nope"))).toMatchObject({ code: "SQLITE_ERROR", message: 'unknown database schema "nope"' });
		expect(() => fresh.serialize(3)).toThrow(TypeError);
		fresh.close();
		// A read-only empty file can't be initialized, so there is nothing to copy.
		const blank = unique("blank");
		driver.open(blank, 1e9, 6);
		driver.close(1e9);
		const empty = await memory(blank, { readonly: true });
		expect(empty.serialize()).toEqual(new Uint8Array(0));
		empty.close();
		db.close();
	});

	it("checkpoints the WAL", async () => {
		const db = await memory();
		db.execute("create table t (x); insert into t values (1)");
		const passive = db.checkpoint();
		expect(passive.busy).toBe(0);
		expect(passive.log).toBeGreaterThan(0);
		expect(passive.checkpointed).toBe(passive.log);
		expect(db.ckpt("truncate")).toEqual({ busy: 0, log: 0, checkpointed: 0 });
		for (const mode of ["full", "restart"]) expect(db.checkpoint(mode).busy).toBe(0);
		expect(() => db.checkpoint("everything")).toThrow(/checkpoint mode must be one of/);
		const rollback = await memory(unique(), { journal: "delete" });
		expect(rollback.checkpoint()).toEqual({ busy: 0, log: -1, checkpointed: -1 });
		rollback.close();
		db.close();
	});

	it("close() finalizes statements, rolls back, and is idempotent", async () => {
		const db = await memory();
		db.execute("create table t (x)");
		const select = db.prepare("select * from t");
		const state = connection(db);
		expect(state.statements.size).toBe(1);
		db.execute("begin; insert into t values (1)");
		db.close();
		db.close();
		expect(state.statements.size).toBe(0);
		expect(state.routes.size).toBe(0);
		const error = thrown(() => select.all());
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_MISUSE", number: 21, message: "database is closed" });
		for (const use of [
			() => db.prepare("select 1"),
			() => db.execute("select 1"),
			() => db.pragma.get("user_version"),
			() => db.serialize(),
			() => db.checkpoint()
		]) {
			expect(use).toThrow(/database is closed/);
		}
		expect(db.info.transaction).toBe(false);
	});

	it("finalizes a statement that is garbage collected", async () => {
		const db = await memory();
		const state = connection(db);
		const before = state.statements.size;
		// A statement that is never closed, only dropped.
		(() => db.prepare("select 1").get())();
		expect(state.statements.size).toBe(before + 1);
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc");
		for (let round = 0; round < 50 && state.statements.size > before; round++) {
			gc();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(state.statements.size).toBe(before);
		db.close();
	});

	it("the finalization callback does nothing for a statement already closed", async () => {
		const db = await memory();
		const state = connection(db);
		const statementState = { pointer: 0 };
		collect({ connection: state, state: statementState });
		expect(statementState.pointer).toBe(0);
		db.close();
	});
});

describe("sqlite.error", () => {
	it("carries the code name, number and SQL", async () => {
		const db = await memory();
		db.execute("create table t (id integer primary key, x unique)");
		db.prepare("insert into t (x) values (1)").run();
		const error = thrown(() => db.prepare("insert into t (x) values (1)").run());
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toBeInstanceOf(sqlite.err);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("sqlite.error");
		expect(error.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
		expect(error.number).toBe(2067);
		expect(error.sql).toBe("insert into t (x) values (1)");
		expect(error.message).toBe("UNIQUE constraint failed: t.x");
		expect(thrown(() => db.prepare("insert into t (id) values (1)").run())).toMatchObject({
			code: "SQLITE_CONSTRAINT_PRIMARYKEY",
			number: 1555
		});
		db.close();
	});

	it("can be constructed directly", () => {
		const error = new sqlite.error("custom", 5);
		expect(error).toMatchObject({ code: "SQLITE_BUSY", number: 5, sql: undefined, message: "custom" });
		expect(new sqlite.error("x", 1, "select", { cause: "why" }).cause).toBe("why");
	});
});
