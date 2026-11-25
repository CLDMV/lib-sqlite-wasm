/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/api/statement.test.vitest.mjs
 *	@Date: 2026-11-25T01:50:53-08:00 (1795600253)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:15-08:00 (1795642215)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, expect, it } from "vitest";
import { memory, sqlite, thrown } from "./helpers.mjs";

async function people() {
	const db = await memory();
	db.execute(`
		create table person (id integer primary key, name text not null, age integer);
		create table pet (id integer primary key, owner integer references person(id), name text);
		insert into person (name, age) values ('ann', 30), ('bob', 40), ('cy', null);
		insert into pet (owner, name) values (1, 'rex'), (2, 'tom');
	`);
	return db;
}

describe("statement", () => {
	it("run() reports changes and the last rowid", async () => {
		const db = await people();
		const insert = db.prepare("insert into person (name) values (?)");
		expect(insert.run("dee")).toEqual({ changes: 1, rowid: 4 });
		expect(db.prepare("update person set age = 1").run()).toEqual({ changes: 4, rowid: 4 });
		expect(db.prepare("insert into person (id, name) values (?, 'big')").run(2n ** 60n)).toEqual({ changes: 1, rowid: 2n ** 60n });
		expect(db.prepare("insert into person (name) values ('x')", { bigint: true }).run().rowid).toBe(2n ** 60n + 1n);
		// run() also works on a statement that returns rows, stepping through them.
		expect(db.prepare("select * from person").run().changes).toBe(1);
		db.close();
	});

	it("get / all / iterate return row objects", async () => {
		const db = await people();
		const select = db.prepare("select name, age from person where id >= ? order by id");
		expect(select.get(2)).toEqual({ name: "bob", age: 40 });
		expect(select.get(99)).toBeUndefined();
		expect(select.all(2)).toEqual([
			{ name: "bob", age: 40 },
			{ name: "cy", age: null }
		]);
		expect([...select.iterate(1)].map((row) => row.name)).toEqual(["ann", "bob", "cy"]);
		expect(select.iter).toBe(select.iterate);
		// A duplicate column name keeps the last value, like an object literal.
		expect(db.prepare("select 1 as a, 2 as a").get()).toEqual({ a: 2 });
		db.close();
	});

	it("raw, pluck and expand shape rows differently", async () => {
		const db = await people();
		const select = db.prepare(
			"select person.name, pet.name, 1 + 1 as two from person join pet on pet.owner = person.id order by person.id"
		);
		expect(select.raw.get()).toEqual(["ann", "rex", 2]);
		expect(select.raw.all()).toEqual([
			["ann", "rex", 2],
			["bob", "tom", 2]
		]);
		expect([...select.raw.iterate()]).toHaveLength(2);
		expect(select.raw.iter).toBe(select.raw.iterate);
		expect(select.pluck.get()).toBe("ann");
		expect(select.pluck.all()).toEqual(["ann", "bob"]);
		expect(select.expand.get()).toEqual({ person: { name: "ann" }, pet: { name: "rex" }, $: { two: 2 } });
		expect(select.expand.all()).toHaveLength(2);
		expect(db.prepare("select 1 where 0").pluck.get()).toBeUndefined();
		expect(db.prepare("select 1 where 0").expand.get()).toBeUndefined();
		expect(db.prepare("select 1 where 0").raw.get()).toBeUndefined();
		expect(Object.isFrozen(select.raw) && Object.isFrozen(select.pluck) && Object.isFrozen(select.expand)).toBe(true);
		db.close();
	});

	it("reading methods refuse a statement that returns no data", async () => {
		const db = await people();
		const update = db.prepare("update person set age = 2");
		for (const read of [() => update.get(), () => update.all(), () => update.iterate(), () => update.raw.get(), () => update.pluck.all()]) {
			expect(read).toThrow(/returns no data; use run\(\)/);
		}
		db.close();
	});

	it("binds positional, numbered and named parameters", async () => {
		const db = await memory();
		const pick = (sql, ...parameters) => db.prepare(sql).raw.get(...parameters);
		expect(pick("select ?, ?, ?", 1, [2, 3])).toEqual([1, 2, 3]);
		// ?NNN takes the NNNth positional value.
		expect(pick("select ?2, ?1", "a", "b")).toEqual(["b", "a"]);
		expect(pick("select :a, @b, $c", { a: 1, b: 2, c: 3 })).toEqual([1, 2, 3]);
		expect(pick("select ?, :x, ?", 1, { x: "named" }, 2)).toEqual([1, "named", 2]);
		expect(pick("select :x", Object.assign(Object.create(null), { x: "bare" }))).toEqual(["bare"]);
		// An object whose prototype isn't Object.prototype (or null) is a value, not a bag of names.
		expect(() => pick("select ?", new (class {})())).toThrow(TypeError);
		expect(() => pick("select :x", {})).toThrow(/missing named parameter "x"/);
		expect(() => pick("select :x")).toThrow(/missing named parameter "x"/);
		expect(() => pick("select :x", { x: 1 }, { y: 2 })).toThrow(/single object/);
		expect(() => pick("select ?, ?", 1)).toThrow(/too few parameter values/);
		expect(() => pick("select ?", 1, 2)).toThrow(/too many parameter values/);
		expect(pick("select 1", { unused: true })).toEqual([1]);
		db.close();
	});

	it("bind() fixes the parameters for every later run", async () => {
		const db = await memory();
		const select = db.prepare("select ? as v").bind(7);
		expect(select.get()).toEqual({ v: 7 });
		expect(select.pluck.all()).toEqual([7]);
		expect(() => select.get(8)).toThrow(/fixed with bind\(\)/);
		expect(() => select.bind(9)).toThrow(/already bound/);
		const failed = db.prepare("select ?");
		expect(() => failed.bind()).toThrow(/too few/);
		expect(failed.bind(1).pluck.get()).toBe(1);
		db.close();
	});

	it("keeps one iterator at a time and resets when it ends", async () => {
		const db = await people();
		const select = db.prepare("select id from person order by id");
		const iterator = select.iterate();
		expect(iterator.next().value).toEqual({ id: 1 });
		expect(() => select.get()).toThrow(/busy/);
		expect(() => select.iterate()).toThrow(/busy/);
		expect(() => select.bind()).toThrow(/busy/);
		expect(iterator.return().done).toBe(true);
		expect(select.get()).toEqual({ id: 1 });
		// Leaving a for-of early returns the iterator.
		for (const row of select.iterate()) {
			expect(row.id).toBe(1);
			break;
		}
		expect(select.all()).toHaveLength(3);
		db.close();
	});

	it("describes its columns and itself", async () => {
		const db = await people();
		const select = db.prepare("select p.name as who, age, 1 as one from person p");
		const expected = [
			{ name: "who", column: "name", table: "person", database: "main", type: "TEXT" },
			{ name: "age", column: "age", table: "person", database: "main", type: "INTEGER" },
			{ name: "one", column: null, table: null, database: null, type: null }
		];
		expect(select.columns()).toEqual(expected);
		expect(select.cols).toBe(select.columns);
		expect(select.info).toEqual({ sql: "select p.name as who, age, 1 as one from person p", reader: true, readonly: true });
		expect(Object.isFrozen(select.info)).toBe(true);
		expect(db.prepare("delete from pet").info).toMatchObject({ reader: false, readonly: false });
		db.close();
	});

	it("close() finalizes the statement; later use throws", async () => {
		const db = await memory();
		const select = db.prepare("select 1");
		select.close();
		select.close();
		const error = thrown(() => select.get());
		expect(error).toBeInstanceOf(sqlite.error);
		expect(error).toMatchObject({ code: "SQLITE_MISUSE", message: "statement is closed", sql: "select 1" });
		expect(() => select.columns()).toThrow(/statement is closed/);
		db.close();
	});

	it("an iterator stops with an error when its statement is closed underneath it", async () => {
		const db = await memory();
		const select = db.prepare("with recursive c(x) as (select 1 union all select x + 1 from c where x < 3) select x from c");
		const iterator = select.raw.iterate();
		expect(iterator.next().value).toEqual([1]);
		select.close();
		expect(() => iterator.next()).toThrow(/statement is closed/);
		db.close();
	});

	it("rethrows a step error with the statement's SQL and resets", async () => {
		const db = await memory();
		db.execute("create table t (x unique)");
		const insert = db.prepare("insert into t values (?)");
		insert.run(1);
		const error = thrown(() => insert.run(1));
		expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE", number: 2067, sql: "insert into t values (?)" });
		expect(insert.run(2).changes).toBe(1);
		db.close();
	});
});
