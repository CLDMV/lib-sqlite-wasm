/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/worker/share.mts
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
 * @fileoverview One database shared by several tabs of an origin (`client.connect(worker, path, { share: true })`).
 *
 * Every tab asks for the Web Lock `sqlite:<path>:leader` and waits. The tab holding it is the leader: it starts its
 * own dedicated worker, which opens the database as an unshared connection would. The other tabs are followers and
 * send their requests to the leader over the BroadcastChannel `sqlite:<path>`; the leader passes them to its worker
 * and broadcasts the answers. When the leader's tab goes away the browser releases the lock, the next waiting tab
 * takes it, starts a worker, opens the database (waiting up to `timeout` for the old worker's files) and announces
 * itself.
 *
 * The coordinator stands where the worker would be: the client's link posts requests to it and gets responses back,
 * so the database surface is the same in every tab.
 *
 * Rules the leader and followers keep:
 *
 * - A request goes to the leader the follower currently knows (`to`), and a leader only runs requests addressed to
 *   it, so a request reaches each leader at most once.
 * - Before it runs a follower's write, the leader broadcasts `started`. After a handover a follower resends what the
 *   old leader never answered, except writes it saw `started` for: those reject with SQLITE_BUSY ("the leader
 *   changed"), since they may or may not have been applied. Reads (SELECT and VALUES statements, column lists,
 *   serialize) are always resent.
 * - A client transaction holds the leader: while one tab's transaction is open, other tabs' requests wait, so a
 *   transaction that awaits results mid-way still runs alone. If that tab goes away mid-transaction (each tab holds the
 *   lock `sqlite:<path>:tab:<id>` for its lifetime, which the leader waits on), the leader rolls the transaction back.
 *   A transaction begun with an old leader is gone with it: what is left of it rejects with SQLITE_BUSY ("rolled
 *   back"), and its ROLLBACK succeeds.
 * - Requests from one tab run in the order it sent them; between tabs, in the order they reach the leader.
 * - A leader that closes keeps serving until its own earlier calls and an open follower transaction are done, then
 *   answers everything it has passed to its worker, closes the database and releases the lock. Follower requests it
 *   didn't pass on are resent to the next leader. A follower that closes waits for its own answers and stops listening.
 * - A leader whose worker ends while the tab stays open (the browser killed it, it was terminated, or it reported an
 *   uncaught error, after which it is terminated) hands over as if its tab had gone: it stops answering, releases the
 *   leader lock and joins again as a follower under a new tab id, so followers see a new leader even when this tab is
 *   elected again. Its own calls follow the same rules as a follower's: writes its worker had started reject with
 *   SQLITE_BUSY, everything else is resent to the next leader. The worker holds the lock `sqlite:<path>:worker:<id>`
 *   for its whole life and the leader waits on it, so the grant is the signal that the worker has ended.
 *
 * Connection state (attached databases, PRAGMA settings, functions registered outside the host's `setup`) lives in the
 * leader's worker and doesn't move with a handover.
 */
import { SQLITE_BUSY, SQLITE_CANTOPEN, SQLITE_MISUSE } from "../core/constants.mts";
import {
	error,
	serialize,
	type call,
	type endpoint,
	type failure,
	type notice,
	type opened,
	type outcome,
	type request,
	type response,
	type settings
} from "./protocol.mts";

/** The parts of a LockManager sharing uses. */
export interface locks {
	request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/** The parts of a BroadcastChannel sharing uses. */
export interface broadcast {
	postMessage(message: unknown): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	close(): void;
}

/** A started worker. Its "error" event is an uncaught error inside it. */
export interface worker extends endpoint {
	terminate(): void;
	addEventListener(type: "message" | "error", listener: (event: { data: unknown }) => void): void;
}

/** What a shared connection needs from the page: Web Locks, BroadcastChannel, a way to start the worker, tab ids. */
export interface environment {
	locks: locks;
	channel(name: string): broadcast;
	spawn(): worker;
	id(): string;
}

/** Called with the new value whenever this tab becomes, or stops being, the leader. */
export type watcher = (leader: boolean) => void;

/**
 * A request this tab made, until it is answered. `sent` is the leader it went to (none while no leader is known);
 * `started` that the leader began it (writes only).
 */
interface own {
	id: number;
	request: request;
	write: boolean;
	sent: string | undefined;
	started: boolean;
	promise: Promise<void>;
	resolve(outcomes: outcome[]): void;
}

/** A request waiting in the leader. `own` is set for the leader's own; `done` marks the leader's close. */
interface entry {
	tab: string;
	request: request;
	write: boolean;
	own?: own;
	done?: () => void;
}

const noop = (): void => {};
/** Statements that only read. Anything else counts as a write, which is the cautious side. */
const READ = /^\s*(select|values)\b/i;

const uncertain: failure = serialize(
	new error("the leader changed while this request was running: it may or may not have been applied", SQLITE_BUSY)
);
const rolledback: failure = serialize(new error("the leader changed during this transaction: it was rolled back", SQLITE_BUSY));
const closed: failure = serialize(new error("the database is closed", SQLITE_MISUSE));
const ended: failure = serialize(new error("the database worker ended before the database was open", SQLITE_CANTOPEN));

/** Whether running `request` twice is harmless. */
export function reads(request: request): boolean {
	return (
		!request.tx &&
		request.calls.every((item) => item.op === "columns" || item.op === "serialize" || (item.op === "statement" && READ.test(item.sql)))
	);
}

/** Every call of `request` failing with `failure`. */
const failing = (request: request, failure: failure): outcome[] => request.calls.map(() => ({ ok: false, error: failure }));

/**
 * The page's Web Locks, BroadcastChannel, Worker and crypto, read once when a shared connection starts.
 * @param target  the worker script, started again by each tab that becomes the leader
 */
export function ambient(target: string | URL): environment {
	const scope = globalThis as unknown as {
		navigator?: { locks?: locks };
		BroadcastChannel?: new (name: string) => broadcast;
		Worker?: new (url: string | URL, options: { type: "module" }) => worker;
		crypto: { randomUUID(): string };
	};
	const locks = scope.navigator?.locks;
	const channel = scope.BroadcastChannel;
	const spawn = scope.Worker;
	if (!locks || !channel || !spawn) throw new TypeError("sqlite-wasm: share needs Web Locks, BroadcastChannel and Worker (a browser page)");
	return {
		locks,
		channel: (name) => new channel(name),
		spawn: () => new spawn(target, { type: "module" }),
		id: () => scope.crypto.randomUUID()
	};
}

/** The stand-in for the worker in a shared connection. */
export class coordinator {
	readonly #env: environment;
	/** This tab's id; a new one after its worker ended, so that followers notice the handover. */
	#me: string;
	readonly #messages = new Set<(event: { data: unknown }) => void>();
	readonly #errors = new Set<(event: { message?: string }) => void>();
	readonly #watchers = new Set<watcher>();
	readonly #own = new Map<number, own>();
	#path = "";
	#settings: settings = {};
	#channel: broadcast | undefined;
	/** The id of the link's open request until it is answered. */
	#opening: number | undefined;
	#info: opened | undefined;
	/** The tab this one sends requests to; itself once it leads. */
	#current: string | undefined;
	#leading = false;
	#stopped = false;
	#abort = new AbortController();
	#untab: () => void = noop;
	#resign: () => void = noop;

	// Leader state.
	#worker: worker | undefined;
	/** Aborts the wait on the worker's lock. */
	#watchdog: AbortController | undefined;
	/** Resolves with the worker's outcomes, or with undefined when the worker ended first. */
	readonly #inflight = new Map<number, (outcomes: outcome[] | undefined) => void>();
	#next = 1;
	#queue: entry[] = [];
	/** The tab whose transaction is open, and the watch on that tab's lock. */
	#owner: string | undefined;
	#ownerwatch: AbortController | undefined;
	/** Set when the leader's close comes up: it no longer takes requests. */
	#halted = false;

	constructor(target: unknown, env: environment) {
		if (typeof target !== "string" && !(target instanceof URL))
			throw new TypeError("sqlite-wasm: share needs the worker script's URL, so another tab can start its own worker");
		this.#env = env;
		this.#me = env.id();
	}

	/** Whether this tab is the leader. */
	get leader(): boolean {
		return this.#leading;
	}

	/** Calls `listener` when this tab becomes, or stops being, the leader; returns the function that stops it. */
	readonly watch = (listener: watcher): (() => void) => {
		this.#watchers.add(listener);
		return () => {
			this.#watchers.delete(listener);
		};
	};

	addEventListener(type: string, listener: (event: never) => void): void {
		if (type === "message") this.#messages.add(listener as (event: { data: unknown }) => void);
		else this.#errors.add(listener as (event: { message?: string }) => void);
	}

	removeEventListener(type: string, listener: (event: never) => void): void {
		this.#messages.delete(listener as (event: { data: unknown }) => void);
	}

	/** A request from the client's link. */
	postMessage(message: unknown): void {
		const item = message as request;
		if (this.#stopped) return this.#deliver({ id: item.id, outcomes: failing(item, closed) });
		if ((item.calls[0] as call).op === "open") return this.#start(item);
		const at = item.calls.findIndex((each) => each.op === "close");
		if (at === -1) void this.#submit(item).then((outcomes) => this.#deliver({ id: item.id, outcomes }));
		else void this.#closing(item, at);
	}

	#deliver(data: response): void {
		for (const listener of this.#messages) listener({ data });
	}

	#flip(leading: boolean): void {
		this.#leading = leading;
		for (const listener of this.#watchers) listener(leading);
	}

	/** Joins: claims this tab's lock, waits for the leader lock, and asks who leads now. */
	#start(item: request): void {
		const open = item.calls[0] as Extract<call, { op: "open" }>;
		this.#opening = item.id;
		this.#path = open.path;
		this.#settings = open.options;
		const channel = this.#env.channel(`sqlite:${this.#path}`);
		this.#channel = channel;
		channel.addEventListener("message", this.#hear);
		this.#join();
	}

	/** Claims this tab's lock, queues for the leader lock, and asks who leads now. */
	#join(): void {
		this.#env.locks
			.request(`sqlite:${this.#path}:tab:${this.#me}`, {}, () => new Promise<void>((done) => (this.#untab = done)))
			.catch(noop);
		this.#env.locks.request(`sqlite:${this.#path}:leader`, { signal: this.#abort.signal }, () => this.#lead()).catch(noop);
		(this.#channel as broadcast).postMessage({ type: "hello", tab: this.#me } satisfies notice);
	}

	/** Holds the leader lock: starts the worker and opens the database, then serves until close. */
	async #lead(): Promise<void> {
		const worker = this.#env.spawn();
		this.#worker = worker;
		worker.addEventListener("message", this.#answer);
		worker.addEventListener("error", () => this.#crashed(worker));
		worker.start?.();
		// The worker takes a lock it never lets go of, and this tab waits for the same lock: the grant means the worker ended.
		const name = `sqlite:${this.#path}:worker:${this.#env.id()}`;
		const holding = this.#ask({ id: 0, tx: false, calls: [{ op: "hold", name }] });
		const opening = this.#ask({ id: 0, tx: false, calls: [{ op: "open", path: this.#path, options: this.#settings }] });
		const [hold] = (await holding) ?? [];
		if ((hold as { value?: unknown } | undefined)?.value === true) this.#watch(worker, name);
		const [result] = ((await opening) ?? [{ ok: false, error: ended }]) as [outcome];
		if (!result.ok) {
			this.#retire(worker);
			this.#fail(result);
			return;
		}
		if (this.#stopped) {
			// This tab closed while its worker was opening the database: close it again and let the next tab lead.
			await this.#ask({ id: 0, tx: false, calls: [{ op: "close" }] });
			this.#retire(worker);
			return;
		}
		const info = result.value as opened;
		const held = new Promise<void>((done) => (this.#resign = done));
		this.#info = info;
		this.#current = this.#me;
		(this.#channel as broadcast).postMessage({ type: "leader", tab: this.#me, info } satisfies notice);
		this.#opened();
		this.#flip(true);
		this.#reroute();
		return held;
	}

	/** Opening failed in this tab's worker: the open (or every pending call) gets the error, and the lock goes to the next tab. */
	#fail(result: Extract<outcome, { ok: false }>): void {
		if (this.#opening !== undefined) this.#deliver({ id: this.#opening, outcomes: [result] });
		else {
			for (const entry of this.#own.values()) this.#settle(entry, failing(entry.request, result.error));
			for (const listener of this.#errors) listener({ message: result.error.message });
		}
		this.#stop();
	}

	/** Answers the link's open once the database is open somewhere. */
	#opened(): void {
		if (this.#opening === undefined) return;
		this.#deliver({ id: this.#opening, outcomes: [{ ok: true, value: this.#info }] });
		this.#opening = undefined;
	}

	readonly #hear = (event: { data: unknown }): void => {
		const message = event.data as notice;
		switch (message.type) {
			case "hello":
				if (this.#current === this.#me && !this.#halted)
					(this.#channel as broadcast).postMessage({ type: "leader", tab: this.#me, info: this.#info as opened } satisfies notice);
				return;
			case "leader":
				if (this.#worker !== undefined || message.tab === this.#current) return;
				this.#current = message.tab;
				this.#info = message.info;
				this.#opened();
				this.#reroute();
				return;
			case "request":
				if (message.to === this.#me && this.#current === this.#me && !this.#halted)
					this.#enqueue({ tab: message.tab, request: message.request, write: message.write });
				return;
			case "started": {
				const entry = message.tab === this.#me ? this.#own.get(message.id) : undefined;
				if (entry?.sent === message.leader) entry.started = true;
				return;
			}
			case "response": {
				const entry = message.tab === this.#me ? this.#own.get(message.response.id) : undefined;
				if (entry) this.#settle(entry, message.response.outcomes);
				return;
			}
		}
	};

	/** A request from this tab: sent to the leader, or kept until one is known. */
	#submit(item: request): Promise<outcome[]> {
		let resolve!: (outcomes: outcome[]) => void;
		const answered = new Promise<outcome[]>((done) => (resolve = done));
		const entry: own = {
			id: item.id,
			request: item,
			write: !reads(item),
			sent: undefined,
			started: false,
			promise: answered.then(noop),
			resolve
		};
		this.#own.set(item.id, entry);
		this.#route(entry);
		return answered;
	}

	#settle(entry: own, outcomes: outcome[]): void {
		this.#own.delete(entry.id);
		entry.resolve(outcomes);
	}

	#route(entry: own): void {
		const current = this.#current;
		entry.sent = current;
		entry.started = false;
		// Between a leader whose worker ended and the next one, requests wait here until #reroute sends them on.
		if (current === undefined) return;
		if (current === this.#me) this.#enqueue({ tab: this.#me, request: entry.request, write: entry.write, own: entry });
		else
			(this.#channel as broadcast).postMessage({
				type: "request",
				to: current,
				tab: this.#me,
				write: entry.write,
				request: entry.request
			} satisfies notice);
	}

	/** The leader changed: resend what the old one didn't answer, except writes it had started. */
	#reroute(): void {
		for (const entry of [...this.#own.values()]) {
			if (entry.started) this.#settle(entry, failing(entry.request, uncertain));
			else this.#route(entry);
		}
	}

	#enqueue(item: entry): void {
		this.#queue.push(item);
		this.#pump();
	}

	/** Runs what may run: everything in order, or only the open transaction's tab while one is open. */
	#pump(): void {
		while (!this.#halted) {
			const owner = this.#owner;
			const index = owner === undefined ? (this.#queue.length > 0 ? 0 : -1) : this.#queue.findIndex((item) => item.tab === owner);
			if (index === -1) return;
			const [item] = this.#queue.splice(index, 1) as [entry];
			this.#dispatch(item);
		}
	}

	#dispatch(item: entry): void {
		if (item.done) return void this.#finish(item.done);
		const { request } = item;
		if (request.tx) {
			if ((request.calls[0] as call).op === "begin") this.#hold(item.tab);
			else if (this.#owner !== item.tab) {
				// The transaction began with an earlier leader and ended with it.
				const outcomes = request.calls.map((each): outcome =>
					each.op === "rollback" || each.op === "revert" ? { ok: true, value: undefined } : { ok: false, error: rolledback }
				);
				return this.#reply(item, outcomes);
			}
			if (request.calls.some((each) => each.op === "commit" || each.op === "rollback")) this.#unhold();
		}
		if (item.write && item.own) item.own.started = true;
		else if (item.write)
			(this.#channel as broadcast).postMessage({ type: "started", leader: this.#me, tab: item.tab, id: request.id } satisfies notice);
		// No outcomes: the worker ended first, and the request is settled or resent as after a handover.
		void this.#ask(request).then((outcomes) => outcomes && this.#reply(item, outcomes));
	}

	#reply(item: entry, outcomes: outcome[]): void {
		if (item.own) this.#settle(item.own, outcomes);
		else
			(this.#channel as broadcast).postMessage({
				type: "response",
				tab: item.tab,
				response: { id: item.request.id, outcomes }
			} satisfies notice);
	}

	/** `tab`'s transaction is open: others wait, and if `tab` goes away first the transaction is rolled back. */
	#hold(tab: string): void {
		this.#owner = tab;
		if (tab === this.#me) return;
		const watch = new AbortController();
		this.#ownerwatch = watch;
		this.#env.locks
			.request(`sqlite:${this.#path}:tab:${tab}`, { signal: watch.signal }, () => {
				if (this.#ownerwatch !== watch) return;
				this.#ownerwatch = undefined;
				this.#owner = undefined;
				this.#queue = this.#queue.filter((each) => each.tab !== tab);
				void this.#ask({ id: 0, tx: true, calls: [{ op: "rollback" }] });
				this.#pump();
			})
			.catch(noop);
	}

	#unhold(): void {
		this.#owner = undefined;
		this.#ownerwatch?.abort();
		this.#ownerwatch = undefined;
	}

	/** Sends `item` to this tab's worker; resolves with the worker's outcomes, or with undefined if the worker ends first. */
	#ask(item: request): Promise<outcome[] | undefined> {
		const id = this.#next++;
		return new Promise((resolve) => {
			this.#inflight.set(id, resolve);
			(this.#worker as worker).postMessage({ id, tx: item.tx, calls: item.calls } satisfies request);
		});
	}

	readonly #answer = (event: { data: unknown }): void => {
		const { id, outcomes } = event.data as response;
		const resolve = this.#inflight.get(id) as (outcomes: outcome[] | undefined) => void;
		this.#inflight.delete(id);
		resolve(outcomes);
	};

	/** The link's close, with any calls sent before it in the same message. */
	async #closing(item: request, at: number): Promise<void> {
		const before = item.calls.slice(0, at);
		const outcomes: outcome[] = before.length > 0 ? await this.#submit({ id: item.id, tx: item.tx, calls: before }) : [];
		await Promise.all([...this.#own.values()].map((entry) => entry.promise));
		if (this.#current === this.#me) await new Promise<void>((done) => this.#enqueue({ tab: this.#me, request: item, write: false, done }));
		else this.#stop();
		outcomes.push({ ok: true, value: undefined }, ...failing({ id: item.id, tx: item.tx, calls: item.calls.slice(at + 1) }, closed));
		this.#deliver({ id: item.id, outcomes });
	}

	/** The leader's close: answers what its worker has, closes the database, and lets the next tab lead. */
	async #finish(done: () => void): Promise<void> {
		this.#halted = true;
		this.#queue = [];
		// The worker answers in order, so once the close is answered everything before it has been answered too.
		await this.#ask({ id: 0, tx: false, calls: [{ op: "close" }] });
		// The worker may have ended during the close (#crashed retired it then).
		if (this.#worker) this.#retire(this.#worker);
		this.#stop();
		done();
	}

	/** Waits on the lock the worker holds for its life: the grant means the worker ended. */
	#watch(worker: worker, name: string): void {
		const watchdog = new AbortController();
		this.#watchdog = watchdog;
		this.#env.locks.request(name, { signal: watchdog.signal }, () => this.#crashed(worker)).catch(noop);
	}

	/** Stops using `worker`: no more watching its lock, and it is terminated (again, if it ended on its own). */
	#retire(worker: worker): void {
		this.#watchdog?.abort();
		this.#watchdog = undefined;
		this.#worker = undefined;
		worker.removeEventListener("message", this.#answer);
		worker.terminate();
	}

	/**
	 * This tab's worker ended while the tab stays open. Every call waiting on it loses its answer. While opening or
	 * closing, #lead or #finish carries on from there. A leader hands over: it drops what it queued, rejects its own
	 * started writes as uncertain (followers do the same with theirs when the next leader announces itself), releases
	 * the leader lock and joins again as a follower with a new id.
	 */
	#crashed(worker: worker): void {
		if (worker !== this.#worker) return;
		this.#retire(worker);
		const lost = [...this.#inflight.values()];
		this.#inflight.clear();
		for (const resolve of lost) resolve(undefined);
		if (!this.#leading || this.#halted) return;
		const closing = this.#queue.find((item) => item.done);
		this.#queue = [];
		this.#unhold();
		this.#current = undefined;
		this.#flip(false);
		const resign = this.#resign;
		this.#resign = noop;
		if (closing) {
			// This tab was closing anyway: it doesn't join again.
			this.#stop();
			resign();
			return (closing.done as () => void)();
		}
		this.#reroute();
		this.#untab();
		this.#me = this.#env.id();
		this.#abort = new AbortController();
		this.#join();
		resign();
	}

	/** Lets go of everything: the leader lock (held or awaited), this tab's lock and the channel. Each step may repeat. */
	#stop(): void {
		this.#stopped = true;
		this.#abort.abort();
		this.#untab();
		this.#resign();
		(this.#channel as broadcast).removeEventListener("message", this.#hear);
		(this.#channel as broadcast).close();
	}
}
