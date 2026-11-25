/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/api/transaction.test.vitest.mjs
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
import { memory, thrown } from "./helpers.mjs";

async function table() {
	const db = await memory();
	db.execute("create table t (x unique)");
	const insert = db.prepare("insert into t values (?)");
	const values = () => db.prepare("select x from t order by x").pluck.all();
	return { db, insert, values };
}

describe("transaction", () => {
	it("commits, passes arguments and this, and returns the callback's value", async () => {
		const { db, insert, values } = await table();
		const add = db.transaction(function (...xs) {
			expect(db.info.transaction).toBe(true);
			for (const x of xs) insert.run(x);
			return { self: this, count: xs.length };
		});
		const self = { name: "caller" };
		expect(add.call(self, 1, 2)).toEqual({ self, count: 2 });
		expect(values()).toEqual([1, 2]);
		expect(db.info.transaction).toBe(false);
		expect(db.tx).toBe(db.transaction);
		db.close();
	});

	it("runs deferred, immediate and exclusive variants", async () => {
		const { db, insert, values } = await table();
		const add = db.transaction((x) => insert.run(x));
		add.deferred(1);
		add.immediate(2);
		add.exclusive(3);
		expect(values()).toEqual([1, 2, 3]);
		db.close();
	});

	it("rolls back and rethrows when the callback throws", async () => {
		const { db, insert, values } = await table();
		const failure = new Error("nope");
		const add = db.transaction((x) => {
			insert.run(x);
			throw failure;
		});
		expect(thrown(() => add(1))).toBe(failure);
		expect(values()).toEqual([]);
		expect(db.info.transaction).toBe(false);
		db.close();
	});

	it("nests as savepoints: an inner failure rolls back only the inner part", async () => {
		const { db, insert, values } = await table();
		const inner = db.transaction((x) => {
			insert.run(x);
			if (x === 2) throw new Error("inner");
		});
		const outer = db.transaction(() => {
			insert.run(1);
			expect(() => inner(2)).toThrow("inner");
			inner(3);
		});
		outer();
		expect(values()).toEqual([1, 3]);
		db.close();
	});

	it("uses a savepoint inside a manual BEGIN and leaves the transaction open", async () => {
		const { db, insert, values } = await table();
		db.execute("begin");
		db.transaction(() => insert.run(1))();
		expect(db.info.transaction).toBe(true);
		db.execute("rollback");
		expect(values()).toEqual([]);
		db.close();
	});

	it("doesn't roll back twice when SQLite already rolled the transaction back", async () => {
		const { db, insert, values } = await table();
		insert.run(1);
		const conflict = db.prepare("insert or rollback into t values (1)");
		const outer = db.transaction(() => {
			insert.run(2);
			conflict.run();
		});
		expect(thrown(() => outer())).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
		const nested = db.transaction(() => db.transaction(() => conflict.run())());
		expect(thrown(() => nested())).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
		expect(values()).toEqual([1]);
		db.close();
	});

	it("rolls back when COMMIT fails", async () => {
		const db = await memory();
		db.execute("create table parent (id integer primary key); create table child (p references parent(id) deferrable initially deferred)");
		const orphan = db.transaction(() => db.prepare("insert into child values (99)").run());
		expect(thrown(() => orphan())).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
		expect(db.info.transaction).toBe(false);
		expect(db.prepare("select count(*) from child").pluck.get()).toBe(0);
		db.close();
	});

	it("refuses promises and non-functions", async () => {
		const { db, insert, values } = await table();
		const later = db.transaction(async (x) => insert.run(x));
		expect(() => later(1)).toThrow(/must not return a promise/);
		expect(values()).toEqual([]);
		expect(db.transaction(() => null)()).toBeNull();
		expect(db.transaction(() => 5)()).toBe(5);
		expect(() => db.transaction("begin")).toThrow(TypeError);
		db.close();
	});

	it("copes with the callback closing the database", async () => {
		const first = await memory();
		expect(() =>
			first.transaction(() => {
				first.close();
				throw new Error("after close");
			})()
		).toThrow("after close");
		const second = await memory();
		expect(thrown(() => second.transaction(() => second.close())())).toMatchObject({
			code: "SQLITE_MISUSE",
			message: "database is closed"
		});
	});
});
