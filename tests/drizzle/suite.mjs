/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/drizzle/suite.mjs
 *	@Date: 2026-11-25T03:30:00-08:00 (1795606200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:17-08:00 (1795642217)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The Drizzle scenarios every environment runs: a schema with foreign keys and an index, migrations,
 * CRUD, joins, relational queries, transactions and prepared queries. `defineSuite()` registers them for one
 * environment, which supplies `open()` (a Drizzle database over a fresh, empty sqlite-wasm database) and says whether
 * Drizzle's API is synchronous. Every Drizzle call is awaited, which works for both kinds. Only transactions differ:
 * Drizzle's synchronous transactions take a synchronous callback and the asynchronous ones an async callback.
 *
 * The migrations are applied by `migrate`, which each environment supplies (a Drizzle migrator, or ours).
 */
import { and, asc, count, desc, eq, gt, like, sql, sum } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "../../src/drizzle.mts";
import * as schema from "./fixtures/schema.mjs";

const { users, posts } = schema;

/** Registers the scenarios under `name`. `open()` resolves to `{ raw, close }`; `migrate(db)` applies the fixtures. */
export function defineSuite({ name, sync, open, migrate, extra }) {
	describe(name, () => {
		let db;
		let raw;
		let close;

		beforeEach(async () => {
			({ raw, close } = await open());
			db = drizzle(raw, { schema });
			await migrate(db);
			return close;
		});

		/** Inserts the two users and three posts most scenarios read. */
		async function seed() {
			await db
				.insert(users)
				.values([
					{
						name: "ada",
						email: "ada@example.com",
						score: 9.5,
						joined: new Date(1700000000000),
						settings: { theme: "dark", tags: ["a", "b"] }
					},
					{ name: "bob", email: "bob@example.com", score: 3.25, active: false }
				])
				.run();
			await db
				.insert(posts)
				.values([
					{ author: 1, title: "first", body: "hello", views: 10 },
					{ author: 1, title: "second", views: 3 },
					{ author: 2, title: "third", body: "hi", views: 7, published: true }
				])
				.run();
		}

		it("keeps the client on $client and builds a drizzle database", () => {
			expect(db.$client).toBe(raw);
			expect(typeof db.select).toBe("function");
			expect(db.query.users).toBeDefined();
		});

		it("inserts with returning and maps every column type", async () => {
			const avatar = Buffer.from([1, 2, 3, 250]);
			const [row] = await db
				.insert(users)
				.values({
					name: "ada",
					email: "ada@example.com",
					score: 2.5,
					joined: new Date(1700000000123),
					settings: { theme: "dark", nested: { list: [1, 2, 3] } },
					counter: 9007199254740993n,
					avatar
				})
				.returning()
				.all();
			expect(row).toMatchObject({
				id: 1,
				name: "ada",
				score: 2.5,
				active: true,
				joined: new Date(1700000000123),
				settings: { theme: "dark", nested: { list: [1, 2, 3] } },
				counter: 9007199254740993n
			});
			expect([...row.avatar]).toEqual([1, 2, 3, 250]);
			const stored = await db.select().from(users).where(eq(users.id, 1)).get();
			expect(stored).toEqual(row);
		});

		it("returns the changes and the rowid from run()", async () => {
			const inserted = await db.insert(users).values({ name: "ada", email: "ada@example.com" }).run();
			if (sync) expect(inserted).toEqual({ changes: 1, lastInsertRowid: 1 });
			else expect(inserted).toBeDefined();
			const updated = await db.update(users).set({ name: "ada l" }).where(eq(users.id, 1)).run();
			if (sync) expect(updated.changes).toBe(1);
			expect(await db.select({ name: users.name }).from(users).get()).toEqual({ name: "ada l" });
		});

		it("get() resolves to undefined when nothing matches", async () => {
			expect(await db.select().from(users).where(eq(users.id, 99)).get()).toBeUndefined();
			expect(await db.select({ id: users.id }).from(users).where(eq(users.id, 99)).get()).toBeUndefined();
			expect(await db.query.users.findFirst({ where: eq(users.id, 99) })).toBeUndefined();
			expect(await db.select().from(users).all()).toEqual([]);
		});

		it("selects with where, order, limit and offset", async () => {
			await seed();
			expect(await db.select({ name: users.name }).from(users).orderBy(desc(users.score)).all()).toEqual([
				{ name: "ada" },
				{ name: "bob" }
			]);
			expect(await db.select({ title: posts.title }).from(posts).where(gt(posts.views, 5)).orderBy(asc(posts.title)).all()).toEqual([
				{ title: "first" },
				{ title: "third" }
			]);
			expect(await db.select({ title: posts.title }).from(posts).orderBy(asc(posts.id)).limit(1).offset(1).all()).toEqual([
				{ title: "second" }
			]);
			expect(await db.select({ name: users.name }).from(users).where(like(users.email, "%bob%")).get()).toEqual({ name: "bob" });
			const active = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.active, false)).all();
			expect(active).toEqual([{ name: "bob", active: false }]);
		});

		it("updates and deletes, with returning", async () => {
			await seed();
			const bumped = await db
				.update(posts)
				.set({ views: sql`${posts.views} + 1` })
				.where(eq(posts.author, 1))
				.returning({ title: posts.title, views: posts.views })
				.all();
			expect(bumped).toEqual([
				{ title: "first", views: 11 },
				{ title: "second", views: 4 }
			]);
			const removed = await db.delete(posts).where(eq(posts.title, "third")).returning().all();
			expect(removed).toEqual([{ id: 3, author: 2, title: "third", body: "hi", views: 7, published: true }]);
			expect(await db.select({ n: count() }).from(posts).get()).toEqual({ n: 2 });
		});

		it("limits update and delete with orderBy and limit", async () => {
			await seed();
			const reset = await db
				.update(posts)
				.set({ views: 0 })
				.orderBy(desc(posts.views))
				.limit(1)
				.returning({ title: posts.title, views: posts.views })
				.all();
			expect(reset).toEqual([{ title: "first", views: 0 }]);
			const removed = await db.delete(posts).orderBy(asc(posts.views)).limit(2).returning({ title: posts.title }).all();
			expect(removed.map((row) => row.title).sort()).toEqual(["first", "second"]);
			expect(await db.select({ title: posts.title }).from(posts).all()).toEqual([{ title: "third" }]);
		});

		it("aggregates", async () => {
			await seed();
			expect(
				await db
					.select({ n: count(), views: sum(posts.views) })
					.from(posts)
					.get()
			).toEqual({ n: 3, views: "20" });
			expect(await db.$count(posts, eq(posts.author, 1))).toBe(2);
			const per = await db.select({ author: posts.author, n: count() }).from(posts).groupBy(posts.author).orderBy(asc(posts.author)).all();
			expect(per).toEqual([
				{ author: 1, n: 2 },
				{ author: 2, n: 1 }
			]);
		});

		it("joins, including the nullable side of a left join", async () => {
			await seed();
			await db.insert(users).values({ name: "cy", email: "cy@example.com" }).run();
			const inner = await db
				.select({ author: users.name, title: posts.title })
				.from(posts)
				.innerJoin(users, eq(posts.author, users.id))
				.orderBy(asc(posts.id))
				.all();
			expect(inner).toEqual([
				{ author: "ada", title: "first" },
				{ author: "ada", title: "second" },
				{ author: "bob", title: "third" }
			]);
			const left = await db
				.select({ name: users.name, title: posts.title })
				.from(users)
				.leftJoin(posts, and(eq(posts.author, users.id), eq(posts.published, true)))
				.orderBy(asc(users.id))
				.all();
			expect(left).toEqual([
				{ name: "ada", title: null },
				{ name: "bob", title: "third" },
				{ name: "cy", title: null }
			]);
			const whole = await db.select().from(users).leftJoin(posts, eq(posts.author, users.id)).where(eq(users.name, "cy")).all();
			expect(whole).toEqual([{ users: expect.objectContaining({ name: "cy" }), posts: null }]);
		});

		it("runs relational queries", async () => {
			await seed();
			const found = await db.query.users.findMany({ with: { posts: { orderBy: asc(posts.id) } }, orderBy: asc(users.id) });
			expect(found.map((user) => [user.name, user.posts.map((post) => post.title)])).toEqual([
				["ada", ["first", "second"]],
				["bob", ["third"]]
			]);
			const one = await db.query.posts.findFirst({ where: eq(posts.title, "third"), with: { author: true } });
			expect(one).toMatchObject({ title: "third", author: { name: "bob", active: false } });
			expect(await db.query.users.findFirst({ columns: { name: true }, where: eq(users.id, 2) })).toEqual({ name: "bob" });
		});

		it("runs prepared queries with placeholders", async () => {
			await seed();
			const byName = db
				.select({ id: users.id, email: users.email })
				.from(users)
				.where(eq(users.name, sql.placeholder("name")))
				.prepare();
			expect(await byName.get({ name: "bob" })).toEqual({ id: 2, email: "bob@example.com" });
			expect(await byName.all({ name: "ada" })).toEqual([{ id: 1, email: "ada@example.com" }]);
			expect(await byName.get({ name: "nobody" })).toBeUndefined();
			const add = db
				.insert(posts)
				.values({ author: sql.placeholder("author"), title: sql.placeholder("title") })
				.prepare();
			await add.run({ author: 2, title: "fourth" });
			await add.run({ author: 2, title: "fifth" });
			expect(await db.$count(posts, eq(posts.author, 2))).toBe(3);
			const found = await db.query.users.findFirst({ where: eq(users.name, sql.placeholder("name")), with: { posts: true } }).prepare();
			expect((await found.execute({ name: "bob" })).posts).toHaveLength(3);
		});

		it("runs raw sql through run, all, get and values", async () => {
			await seed();
			// Without selected fields, Drizzle hands back what the driver returns: objects from the synchronous driver,
			// positional rows from sqlite-proxy.
			expect(await db.all(sql`select name from users order by id`)).toEqual(sync ? [{ name: "ada" }, { name: "bob" }] : [["ada"], ["bob"]]);
			expect(await db.get(sql`select name from users where id = ${2}`)).toEqual(sync ? { name: "bob" } : ["bob"]);
			expect(await db.values(sql`select id, name from users order by id`)).toEqual([
				[1, "ada"],
				[2, "bob"]
			]);
			await db.run(sql`update users set score = score + 1`);
			expect(await db.values(sql`select score from users order by id`)).toEqual([[10.5], [4.25]]);
		});

		it("enforces foreign keys, unique constraints and cascades", async () => {
			await seed();
			await expect(Promise.resolve().then(() => db.insert(posts).values({ author: 99, title: "orphan" }).run())).rejects.toThrow();
			const unique = await Promise.resolve()
				.then(() => db.insert(users).values({ name: "ada2", email: "ada@example.com" }).run())
				.catch((thrown) => thrown);
			expect(unique).toBeInstanceOf(Error);
			expect(`${unique.message} ${unique.cause?.message ?? ""} ${unique.cause?.code ?? ""}`).toMatch(/UNIQUE/);
			await db.delete(users).where(eq(users.id, 1)).run();
			expect(await db.select({ title: posts.title }).from(posts).all()).toEqual([{ title: "third" }]);
		});

		it("applies migrations once and records them", async () => {
			const recorded = await db.values(sql`select count(*) from __drizzle_migrations`);
			expect(recorded).toEqual([[2]]);
			await migrate(db);
			expect(await db.values(sql`select count(*) from __drizzle_migrations`)).toEqual([[2]]);
			const tables = await db.values(sql`select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name`);
			expect(tables).toEqual([["__drizzle_migrations"], ["posts"], ["users"]]);
			const index = await db.values(sql`select name from sqlite_schema where type = 'index' and name = 'users_name_idx'`);
			expect(index).toEqual([["users_name_idx"]]);
			expect(await db.values(sql`select count(*) from pragma_foreign_key_list('posts')`)).toEqual([[1]]);
		});

		describe("transactions", () => {
			/** Runs `body(tx)` in a transaction: a plain function for synchronous Drizzle, an async one otherwise. */
			const transact = (body, config) => (sync ? db.transaction((tx) => body(tx), config) : db.transaction(async (tx) => body(tx), config));

			it("commits what the callback did and returns its result", async () => {
				const value = await (sync
					? db.transaction((tx) => {
							tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
							return tx.select({ n: count() }).from(users).get();
						})
					: db.transaction(async (tx) => {
							await tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
							return tx.select({ n: count() }).from(users).get();
						}));
				expect(value).toEqual({ n: 1 });
				expect(await db.$count(users)).toBe(1);
			});

			it("rolls back when the callback throws, and rethrows", async () => {
				const failure = await Promise.resolve()
					.then(() =>
						sync
							? db.transaction((tx) => {
									tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
									throw new Error("undo");
								})
							: db.transaction(async (tx) => {
									await tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
									throw new Error("undo");
								})
					)
					.catch((thrown) => thrown);
				expect(failure.message).toBe("undo");
				expect(await db.$count(users)).toBe(0);
			});

			it("rolls back on tx.rollback()", async () => {
				const failure = await Promise.resolve()
					.then(() =>
						sync
							? db.transaction((tx) => {
									tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
									tx.rollback();
								})
							: db.transaction(async (tx) => {
									await tx.insert(users).values({ name: "ada", email: "a@example.com" }).run();
									tx.rollback();
								})
					)
					.catch((thrown) => thrown);
				expect(failure.message).toMatch(/Rollback/);
				expect(await db.$count(users)).toBe(0);
			});

			it("nests: a failed inner transaction undoes only itself", async () => {
				const outcome = await (sync
					? db.transaction((tx) => {
							tx.insert(users).values({ name: "outer", email: "outer@example.com" }).run();
							try {
								tx.transaction((inner) => {
									inner.insert(users).values({ name: "inner", email: "inner@example.com" }).run();
									inner.transaction((deepest) => {
										deepest.insert(users).values({ name: "deepest", email: "deepest@example.com" }).run();
									});
									throw new Error("inner failed");
								});
							} catch (thrown) {
								tx.insert(users).values({ name: "after", email: "after@example.com" }).run();
								return thrown.message;
							}
						})
					: db.transaction(async (tx) => {
							await tx.insert(users).values({ name: "outer", email: "outer@example.com" }).run();
							try {
								await tx.transaction(async (inner) => {
									await inner.insert(users).values({ name: "inner", email: "inner@example.com" }).run();
									await inner.transaction(async (deepest) => {
										await deepest.insert(users).values({ name: "deepest", email: "deepest@example.com" }).run();
									});
									throw new Error("inner failed");
								});
							} catch (thrown) {
								await tx.insert(users).values({ name: "after", email: "after@example.com" }).run();
								return thrown.message;
							}
						}));
				expect(outcome).toBe("inner failed");
				expect((await db.select({ name: users.name }).from(users).orderBy(asc(users.id)).all()).map((row) => row.name)).toEqual([
					"outer",
					"after"
				]);
			});

			it("commits a nested transaction that succeeds", async () => {
				await transact(
					sync
						? (tx) => {
								tx.insert(users).values({ name: "a", email: "a@example.com" }).run();
								tx.transaction((inner) => inner.insert(users).values({ name: "b", email: "b@example.com" }).run());
							}
						: async (tx) => {
								await tx.insert(users).values({ name: "a", email: "a@example.com" }).run();
								await tx.transaction((inner) => inner.insert(users).values({ name: "b", email: "b@example.com" }).run());
							}
				);
				expect(await db.$count(users)).toBe(2);
			});

			for (const behavior of ["deferred", "immediate", "exclusive"]) {
				it(`starts a ${behavior} transaction`, async () => {
					await transact(
						sync
							? (tx) => {
									tx.insert(users).values({ name: "a", email: "a@example.com" }).run();
								}
							: async (tx) => {
									await tx.insert(users).values({ name: "a", email: "a@example.com" }).run();
								},
						{ behavior }
					);
					expect(await db.$count(users)).toBe(1);
				});
			}

			it("rolls back everything when a statement in the transaction fails", async () => {
				await seed();
				const failure = await Promise.resolve()
					.then(() =>
						sync
							? db.transaction((tx) => {
									tx.update(posts).set({ views: 0 }).run();
									tx.insert(users).values({ name: "dup", email: "ada@example.com" }).run();
								})
							: db.transaction(async (tx) => {
									await tx.update(posts).set({ views: 0 }).run();
									await tx.insert(users).values({ name: "dup", email: "ada@example.com" }).run();
								})
					)
					.catch((thrown) => thrown);
				expect(failure).toBeInstanceOf(Error);
				expect(await db.select({ views: posts.views }).from(posts).orderBy(asc(posts.id)).all()).toEqual([
					{ views: 10 },
					{ views: 3 },
					{ views: 7 }
				]);
			});
		});

		extra?.({
			get db() {
				return db;
			},
			get raw() {
				return raw;
			},
			seed
		});
	});
}
