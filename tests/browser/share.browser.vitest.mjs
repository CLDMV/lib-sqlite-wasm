/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/browser/share.browser.vitest.mjs
 *	@Date: 2026-11-25T06:00:00-08:00 (1795615200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T06:00:00-08:00 (1795615200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * One OPFS database shared by several tabs, in Chromium. Each "tab" is a same-origin iframe of the test page that
 * imports the client into its own realm, so it has its own Web Locks client, BroadcastChannels and workers. Removing
 * the iframe is the tab closing: the browser terminates its workers, releases its locks and closes its channels, the
 * same as for a closed tab.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const library = new URL("../../src/worker/client.mts", import.meta.url).href;
const script = new URL("./fixtures/share-worker.mjs", import.meta.url).href;
const insert = "insert into t(v) values (?)";
const frames = [];
let counter = 0;

/** A new tab: an iframe with the client loaded in it. */
async function tab() {
	const frame = document.createElement("iframe");
	document.body.append(frame);
	frames.push(frame);
	// A function made in the iframe's realm imports into that realm, so the client runs on the iframe's own globals.
	const loaded = await new frame.contentWindow.Function("url", "return import(url)")(library);
	return {
		connect: (path, options = {}) => loaded.default.connect(script, path, { share: true, timeout: 10000, ...options }),
		close: () => frame.remove()
	};
}

/** A database name no other test uses. */
const unique = () => `share-${Date.now()}-${++counter}.db`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (db) => db.prepare("select count(*) from t").pluck.get();

afterEach(() => {
	for (const frame of frames.splice(0)) frame.remove();
});

describe("sharing between tabs", () => {
	it("elects one leader; followers read, write and run transactions through it", async () => {
		const path = unique();
		const tabs = await Promise.all([tab(), tab(), tab()]);
		const a = await tabs[0].connect(path);
		const b = await tabs[1].connect(path);
		const c = await tabs[2].connect(path);
		expect([a.info.leader, b.info.leader, c.info.leader]).toEqual([true, false, false]);
		expect(b.info).toMatchObject({ storage: "opfs", lock: "web" });

		await b.execute("create table t(id integer primary key, v)");
		await c.prepare(insert).run("c");
		await b.transaction(async (tx) => {
			await tx.prepare(insert).run("b1");
			await b
				.transaction(async (inner) => {
					await inner.prepare(insert).run("undone");
					throw new Error("undo");
				})
				.catch(() => {});
			await tx.prepare(insert).run("b2");
		});
		expect(await a.prepare("select v from t order by id").pluck.all()).toEqual(["c", "b1", "b2"]);

		// A follower that closes just stops; the others go on.
		await c.close();
		await b.prepare(insert).run("b3");
		expect(await count(a)).toBe(4);
	});

	it("hands over when the leader's tab closes mid-stream: reads are retried, a running write is reported and not repeated", async () => {
		const path = unique();
		const tabs = await Promise.all([tab(), tab(), tab()]);
		const a = await tabs[0].connect(path);
		const b = await tabs[1].connect(path);
		const c = await tabs[2].connect(path);
		await a.execute("create table t(id integer primary key, v)");
		const changes = [];
		b.info.watch((leader) => changes.push(leader));

		// The write is still running in the leader's worker when its tab goes; the read waits behind it.
		const write = b.prepare("insert into t(v) values (pause(2000))").run();
		const read = c.prepare("select count(*) from t").pluck.get();
		await sleep(500);
		tabs[0].close();

		const failure = await write.catch((thrown) => thrown);
		expect(failure).toMatchObject({ code: "SQLITE_BUSY", number: 5 });
		expect(failure.message).toMatch(/leader changed while this request was running/);
		// Whether the browser stops the busy worker before the write commits is up to it (Chromium often lets the statement
		// finish): the write ran at most once, and the retried read, answered by the new leader, sees whichever it was.
		const rows = await read;
		expect([0, 1]).toContain(rows);
		await vi.waitFor(() => expect(b.info.leader).toBe(true), { timeout: 15000 });
		expect(changes).toEqual([true]);
		expect(await count(c)).toBe(rows);

		await c.prepare(insert).run("after");
		const late = await tab();
		const d = await late.connect(path);
		expect(d.info.leader).toBe(false);
		expect(await count(d)).toBe(rows + 1);
	});

	it("hands over cleanly when the leader closes: every write runs exactly once", async () => {
		const path = unique();
		const tabs = await Promise.all([tab(), tab()]);
		const a = await tabs[0].connect(path);
		const b = await tabs[1].connect(path);
		await a.execute("create table t(id integer primary key, v)");
		const writes = [];
		for (let index = 0; index < 20; index++) {
			writes.push(b.prepare(insert).run(index));
			if (index === 10) writes.push(a.close());
			await null;
		}
		await Promise.all(writes);
		expect(a.info.open).toBe(false);
		expect(b.info.leader).toBe(true);
		expect(await count(b)).toBe(20);
		expect(await b.prepare("select count(distinct v) from t").pluck.get()).toBe(20);
	});
});
