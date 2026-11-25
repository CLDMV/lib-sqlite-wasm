/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /tests/fakes/tabs.mjs
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
 * @fileoverview Several browser tabs of one origin, in one Node process: each fake tab has its own Web Locks client,
 * BroadcastChannel and Worker constructors, and `kill()` makes it go away the way a closed tab does.
 *
 * - Locks are exclusive and granted in request order; a callback runs in a microtask after the grant, and the lock is
 *   released when the callback's promise settles. `signal` aborts a waiting request (it rejects with the reason).
 * - A BroadcastChannel delivers a structured clone of each message, in a microtask, to every other open channel of the
 *   same name in the origin, never to itself.
 * - A worker runs whatever `start(port)` puts on the other end of a MessageChannel. `hold` keeps the tab's messages
 *   from reaching it (they are dropped if the worker dies first), `mute` drops its answers (`answers` still records
 *   them). `terminate()` drops
 *   everything in flight and calls the stop function `start` returned, with the tab-side port.
 * - `kill()` releases every lock the tab holds, forgets the requests it is waiting on, closes its channels and
 *   terminates its workers. The tab's JavaScript keeps running (it can't be stopped here), but nothing it does reaches
 *   anyone any more.
 */

/** A worker whose other end runs `start(port)`. */
export class fakeworker {
	hold = false;
	mute = false;
	dead = false;
	held = [];
	sent = [];
	answers = [];
	#listeners = new Set();
	#stop;

	constructor(start, ports) {
		const { port1, port2 } = new MessageChannel();
		ports.push(port1, port2);
		this.port = port1;
		port1.onmessage = (event) => {
			if (this.dead) return;
			this.answers.push(event.data);
			if (this.mute) return;
			for (const listener of this.#listeners) listener({ data: event.data });
		};
		this.#stop = start(port2);
	}

	postMessage(message) {
		if (this.dead) return;
		this.sent.push(message);
		if (this.hold) this.held.push(message);
		else this.port.postMessage(message);
	}

	/** Lets held messages through. */
	release() {
		this.hold = false;
		for (const message of this.held.splice(0)) this.port.postMessage(message);
	}

	addEventListener(type, listener) {
		if (type === "message") this.#listeners.add(listener);
	}

	removeEventListener(type, listener) {
		this.#listeners.delete(listener);
	}

	start() {}

	terminate() {
		if (this.dead) return;
		this.dead = true;
		this.held = [];
		this.#stop?.(this.port);
	}
}

/**
 * An origin. `start(port)` starts a worker's other end (and may return a stop function); every Worker any tab creates
 * runs it.
 */
export function fakeorigin(start) {
	const ports = [];
	const locks = new Map();
	const channels = new Set();
	/** Every message any channel posted, as { name, tab, data }. */
	const posted = [];
	let tabs = 0;

	const state = (name) => {
		let found = locks.get(name);
		if (!found) locks.set(name, (found = { holder: undefined, queue: [] }));
		return found;
	};

	/** Hands the lock to the next waiter, if any. */
	const next = (name) => {
		const found = locks.get(name);
		const waiter = found.queue.shift();
		if (waiter) waiter.grant();
		else locks.delete(name);
	};

	const tab = () => {
		const self = { id: ++tabs, dead: false, workers: [], channels: new Set(), waiting: new Set() };

		self.locks = {
			request(name, options, callback) {
				if (self.dead) return new Promise(() => {});
				return new Promise((resolve, reject) => {
					const found = state(name);
					const waiter = {
						tab: self,
						grant() {
							self.waiting.delete(waiter);
							found.holder = waiter;
							queueMicrotask(() => {
								let result;
								try {
									result = Promise.resolve(callback({ name, mode: "exclusive" }));
								} catch (thrown) {
									result = Promise.reject(thrown);
								}
								result.then(
									(value) => {
										waiter.release();
										resolve(value);
									},
									(thrown) => {
										waiter.release();
										reject(thrown);
									}
								);
							});
						},
						release() {
							if (found.holder !== waiter) return;
							found.holder = undefined;
							next(name);
						}
					};
					const signal = options.signal;
					if (signal?.aborted) return reject(signal.reason);
					signal?.addEventListener("abort", () => {
						const at = found.queue.indexOf(waiter);
						if (at === -1) return;
						found.queue.splice(at, 1);
						self.waiting.delete(waiter);
						reject(signal.reason);
					});
					if (found.holder === undefined && found.queue.length === 0) waiter.grant();
					else {
						found.queue.push(waiter);
						self.waiting.add(waiter);
					}
				});
			}
		};

		self.BroadcastChannel = class {
			#listeners = new Set();
			closed = false;

			constructor(name) {
				this.name = name;
				channels.add(this);
				self.channels.add(this);
			}

			postMessage(data) {
				if (this.closed) throw new DOMException("channel is closed", "InvalidStateError");
				if (self.dead) return;
				const copy = structuredClone(data);
				posted.push({ name: this.name, tab: self.id, data: copy });
				for (const other of channels) {
					if (other === this || other.name !== this.name) continue;
					queueMicrotask(() => other.deliver(copy));
				}
			}

			deliver(data) {
				if (this.closed) return;
				for (const listener of this.#listeners) listener({ data: structuredClone(data) });
			}

			addEventListener(type, listener) {
				this.#listeners.add(listener);
			}

			removeEventListener(type, listener) {
				this.#listeners.delete(listener);
			}

			close() {
				this.closed = true;
				channels.delete(this);
			}
		};

		self.Worker = class extends fakeworker {
			constructor(url, options) {
				super(start, ports);
				this.url = url;
				this.options = options;
				this.hold = origin.hold;
				self.workers.push(this);
			}
		};

		self.navigator = { locks: self.locks };

		/** The tab goes away: its locks are released, its channels closed, its workers terminated. */
		self.kill = () => {
			self.dead = true;
			for (const found of locks.values()) {
				found.queue = found.queue.filter((waiter) => waiter.tab !== self);
			}
			for (const [name, found] of [...locks]) {
				if (found.holder?.tab === self) {
					found.holder = undefined;
					next(name);
				}
			}
			for (const channel of self.channels) channel.close();
			for (const worker of self.workers) worker.terminate();
		};

		return self;
	};

	/** Whether `name` is held right now. */
	const held = (name) => locks.get(name)?.holder !== undefined;

	/** `hold`: workers start with their incoming messages held. */
	const origin = { tab, posted, held, ports, channels, hold: false };
	return origin;
}
