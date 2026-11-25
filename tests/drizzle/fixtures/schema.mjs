/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: tests/drizzle/fixtures/schema.mjs
 *	@Date: 2026-11-25T03:20:00-08:00 (1795605600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:16-08:00 (1795642216)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The schema the Drizzle tests run against. `npm run drizzle:generate` turns it into the migrations
 * in ./migrations; commit both together.
 */
import { relations } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
	"users",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		score: real("score").default(0),
		active: integer("active", { mode: "boolean" }).notNull().default(true),
		joined: integer("joined", { mode: "timestamp_ms" }),
		settings: text("settings", { mode: "json" }).$type(),
		counter: blob("counter", { mode: "bigint" }),
		avatar: blob("avatar", { mode: "buffer" })
	},
	(table) => [index("users_name_idx").on(table.name)]
);

export const posts = sqliteTable("posts", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	author: integer("author")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	title: text("title").notNull(),
	body: text("body"),
	views: integer("views").notNull().default(0),
	published: integer("published", { mode: "boolean" }).notNull().default(false)
});

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.author], references: [users.id] }) }));
