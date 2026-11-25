# @cldmv/sqlite-wasm

SQLite 3.54.1 compiled to WebAssembly, with one build and one API for Node.js and browsers. Databases are real files on disk in Node, OPFS in a browser worker, or memory anywhere. The API is synchronous wherever the storage is (Node, browser workers), and there is an async client for the browser main thread. Database files are standard SQLite files: ones written by native SQLite open here and the other way round.

The module is built from SQLite's own source archive with wasi-sdk, with no Emscripten runtime and no fork of another wasm SQLite project. SQLite's generators produce the amalgamation from the archive, and nothing in it is patched. The wasm is built in CI from a pinned SQLite version and hash; nothing binary is committed.

- Node.js (real files, owner lock between processes) and browser workers (OPFS, Web Locks)
- WAL by default, with the standard on-disk format
- User-defined functions, aggregates, window functions and collations
- Backup, serialize, attach, checkpoint
- Optional [Drizzle ORM](https://orm.drizzle.team) driver, sync and async
- Several browser tabs can share one database

## ✨ What's New

### Latest: v0.1.0 (November 2026)

- **First release** — SQLite 3.54.1 compiled to WebAssembly from SQLite's own source archive, with one synchronous API for Node.js (real files, owner lock between processes) and browser workers (OPFS, Web Locks), plus an async client for the browser main thread. WAL by default, standard on-disk files, an optional Drizzle ORM driver, and several browser tabs sharing one database with automatic handover.
- [View full v0.1.0 Changelog](https://github.com/CLDMV/lib-sqlite-wasm/blob/master/docs/changelog/v0/v0.1.0.md)

## Contents

- [What's New](#-whats-new)
- [Install](#install)
- [Quick start](#quick-start)
- [API](#api)
- [Storage and journal modes](#storage-and-journal-modes)
- [Locking](#locking)
- [Browser: worker and host](#browser-worker-and-host)
- [Multi-tab sharing](#multi-tab-sharing)
- [Drizzle](#drizzle)
- [What is compiled in](#what-is-compiled-in)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Install

```sh
npm install @cldmv/sqlite-wasm
```

Drizzle support is optional. Install `drizzle-orm` (`^0.45.0`) next to it if you want it.

### Entry points

| Import                       | What it is                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@cldmv/sqlite-wasm`         | `sqlite.open()` and `sqlite.error`. ESM and CommonJS (`require()` needs Node.js `^20.19.0` or `>=22.13.0`). Works in Node and inside a browser worker. |
| `@cldmv/sqlite-wasm/host`    | Worker side of the main-thread client: `host.listen(self)`. ESM only.                                                                                  |
| `@cldmv/sqlite-wasm/worker`  | Main-thread client: `client.connect(workerUrl, path, options)`. ESM only.                                                                              |
| `@cldmv/sqlite-wasm/drizzle` | `drizzle()` and `migrate()`. ESM and CommonJS.                                                                                                         |

Nothing runs at import time. The wasm module is compiled and instantiated by the first `sqlite.open()`.

## Quick start

### Node.js

```js
import sqlite from "@cldmv/sqlite-wasm";

const db = await sqlite.open("app.sqlite3");

db.execute("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

const insert = db.prepare("INSERT INTO note (body) VALUES (?)");
insert.run("hello"); // { changes: 1, rowid: 1 }

const add = db.transaction((bodies) => {
	for (const body of bodies) insert.run(body);
});
add(["one", "two", "three"]);

db.prepare("SELECT * FROM note WHERE id = ?").get(1); // { id: 1, body: "hello" }
db.prepare("SELECT body FROM note").pluck.all(); // ["hello", "one", "two", "three"]

db.close();
```

`sqlite.open()` is the only async call. Everything after it is synchronous. With CommonJS:

```js
const sqlite = require("@cldmv/sqlite-wasm");
const db = await sqlite.open(":memory:");
```

### Browser

A persistent database lives in OPFS and OPFS's synchronous handles only exist in dedicated workers, so the database runs in a worker and the page talks to it through an async client. The worker file is three lines:

```js
// db-worker.mjs
import host from "@cldmv/sqlite-wasm/host";

host.listen(self);
```

The page connects to it:

```js
import client from "@cldmv/sqlite-wasm/worker";

const db = await client.connect(new URL("./db-worker.mjs", import.meta.url), "app.sqlite3");

await db.execute("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
await db.prepare("INSERT INTO note (body) VALUES (?)").run("hello");
await db.prepare("SELECT * FROM note").all(); // [{ id: 1, body: "hello" }]
```

Inside a dedicated worker you can also use `sqlite.open()` directly and get the synchronous API on OPFS. `storage: "auto"` on the main thread throws; use the worker client, or `storage: "memory"`.

## API

Names are single lowercase words (`statement`, `database`, `row`). A few have a short alias, which is the same function under a second name. Aliases are listed next to their full names below and again in the [alias table](#aliases).

### `sqlite`

```js
import sqlite from "@cldmv/sqlite-wasm";
// or: import { open, error, err } from "@cldmv/sqlite-wasm";
```

| Member                              | Description                                    |
| ----------------------------------- | ---------------------------------------------- |
| `sqlite.open(path, options?)`       | Opens a database and resolves to a `database`. |
| `sqlite.error` (alias `sqlite.err`) | The class of every error SQLite reports.       |

#### Open options

| Option     | Default    | Description                                                                                                                                                        |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`  | `"auto"`   | `"auto"`, `"fs"`, `"opfs"` or `"memory"`. `"auto"` picks `fs` in Node and `opfs` in a dedicated browser worker. The paths `":memory:"` and `""` always use memory. |
| `readonly` | `false`    | Open read-only.                                                                                                                                                    |
| `create`   | `true`     | Create the file if it does not exist (ignored when read-only).                                                                                                     |
| `journal`  | `"wal"`    | `"wal"`, `"truncate"` or `"delete"`. See [journal modes](#journal-modes).                                                                                          |
| `sync`     | `"normal"` | `PRAGMA synchronous`: `"off"`, `"normal"`, `"full"` or `"extra"`.                                                                                                  |
| `foreign`  | `true`     | Enforce foreign keys.                                                                                                                                              |
| `timeout`  | `5000`     | Milliseconds to wait for a lock held by another process or tab. Also the SQLite busy timeout.                                                                      |
| `bigint`   | `false`    | Return every INTEGER as a `bigint`. Integers outside the safe range are always `bigint`.                                                                           |
| `lock`     | `"beside"` | Node only: how other processes are kept out. See [locking](#locking).                                                                                              |

### `database`

```js
const db = await sqlite.open("app.sqlite3");
```

| Member                                                  | Description                                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.prepare(sql, { bigint }?)` (alias `db.prep`)        | Compiles one statement and returns a `statement`. Throws if the SQL holds more than one statement.                                                                                       |
| `db.execute(sql)` (alias `db.exec`)                     | Runs one or more statements and discards rows. Returns `db`.                                                                                                                             |
| `db.transaction(callback)` (alias `db.tx`)              | Wraps `callback` so each call runs in a transaction. See [transactions](#transactions).                                                                                                  |
| `db.pragma.get(name)`                                   | The first value `PRAGMA name` returns.                                                                                                                                                   |
| `db.pragma.set(name, value)`                            | Runs `PRAGMA name = value` and returns the first value it returns, if any.                                                                                                               |
| `db.pragma.all(name, argument?)`                        | Every row `PRAGMA name` (or `PRAGMA name(argument)`) returns.                                                                                                                            |
| `db.fn.scalar(name, callback, options?)`                | Registers a scalar function.                                                                                                                                                             |
| `db.fn.aggregate(name, definition)` (alias `db.fn.agg`) | Registers an aggregate, or a window function when `inverse` is given.                                                                                                                    |
| `db.fn.collation(name, compare)`                        | Registers a collation.                                                                                                                                                                   |
| `await db.attach(path, schema, { storage }?)`           | Attaches another database file as `schema`.                                                                                                                                              |
| `await db.detach(schema)`                               | Detaches it.                                                                                                                                                                             |
| `await db.backup(target, { storage, schema }?)`         | Copies the database (or an attached `schema`) into the file `target` with SQLite's backup API, replacing what was there.                                                                 |
| `db.serialize(schema?)`                                 | The database (or an attached schema) as a `Uint8Array` holding an SQLite file.                                                                                                           |
| `db.checkpoint(mode?)` (alias `db.ckpt`)                | Runs a WAL checkpoint; `mode` is `"passive"` (default), `"full"`, `"restart"` or `"truncate"`. Returns `{ busy, log, checkpointed }`.                                                    |
| `db.close()`                                            | Finalizes every statement and closes the connection. A WAL database is checkpointed and its `-wal` file removed, so native SQLite can open it afterwards. Calling it again does nothing. |
| `db.info.path`                                          | The path the database was opened with.                                                                                                                                                   |
| `db.info.storage`                                       | The storage driver in use.                                                                                                                                                               |
| `db.info.lock`                                          | The lock in effect: `"beside"`, `"temp"`, the folder you passed, `"db"`, `"web"` (OPFS) or `"none"` (memory). `"beside"` reads `"temp"` when it fell back.                               |
| `db.info.open`                                          | Whether the connection is still open.                                                                                                                                                    |
| `db.info.transaction`                                   | Whether a transaction is open.                                                                                                                                                           |

`attach` and `detach` are async because opening a file in OPFS or taking an owner lock is. The `bigint` option of `db.prepare()` overrides the database's setting for that statement.

User-defined functions:

```js
db.fn.scalar("slug", (text) => text.toLowerCase().replaceAll(" ", "-"), { deterministic: true });

db.fn.aggregate("total", {
	start: 0,
	step: (sum, value) => sum + value,
	result: (sum) => sum
});

db.fn.collation("by_length", (a, b) => a.length - b.length);
```

Function options are `deterministic`, `variadic` (accept any number of arguments instead of the callback's declared count) and `bigint` (pass INTEGER arguments as `bigint`). An aggregate's `start` is the initial accumulator, or a function returning a fresh one for each group. Adding `inverse` makes it a window function. If a callback throws, the statement fails with that same exception.

### `statement`

| Member                                            | Description                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `stmt.run(...parameters)`                         | Executes the statement and returns `{ changes, rowid }`.                                              |
| `stmt.get(...parameters)`                         | The first row as an object, or `undefined`.                                                           |
| `stmt.all(...parameters)`                         | Every row as an object.                                                                               |
| `stmt.iterate(...parameters)` (alias `stmt.iter`) | An iterator over the rows. The statement cannot run again until the iterator finishes or is returned. |
| `stmt.raw.get / .all / .iterate` (alias `.iter`)  | Rows as positional arrays.                                                                            |
| `stmt.pluck.get / .all`                           | The first column only.                                                                                |
| `stmt.expand.get / .all`                          | Rows grouped by source table: `{ table: { column: value } }`, with `"$"` for expressions.             |
| `stmt.bind(...parameters)`                        | Fixes the parameters for every later run, which must then pass none. Callable once. Returns `stmt`.   |
| `stmt.columns()` (alias `stmt.cols`)              | Describes the result columns: `{ name, column, table, database, type }`.                              |
| `stmt.close()`                                    | Finalizes the statement.                                                                              |
| `stmt.info.sql`                                   | The SQL text.                                                                                         |
| `stmt.info.reader`                                | Whether the statement returns rows.                                                                   |
| `stmt.info.readonly`                              | Whether it leaves the database unchanged.                                                             |

`get`, `all` and `iterate` throw on a statement that returns no rows; use `run()` for those.

Parameters are positional (`stmt.run("a", 1)`) or one object of named values whose keys have no `:`, `@` or `$` prefix (`stmt.run({ name: "a" })` for `:name`). Statements are finalized by `close()`, by `db.close()` and, as a safety net, by a `FinalizationRegistry`, so a forgotten statement does not keep the database locked.

### Values

| JavaScript            | SQLite                                           |
| --------------------- | ------------------------------------------------ |
| `null`, `undefined`   | `NULL`                                           |
| safe integer `number` | `INTEGER`                                        |
| other `number`        | `REAL`                                           |
| `bigint`              | `INTEGER` (throws if it does not fit in 64 bits) |
| `boolean`             | `INTEGER` 1 or 0                                 |
| `string`              | `TEXT` (UTF-8, embedded NUL kept)                |
| `Uint8Array`          | `BLOB`                                           |

Reading goes the other way: INTEGER is a `number` when it fits in the safe range and a `bigint` otherwise (always `bigint` with `bigint: true`), REAL is a `number`, TEXT a `string`, BLOB a fresh `Uint8Array`, NULL `null`. Anything else (a `Date`, a plain object in a value position) is a `TypeError`.

### Transactions

```js
const transfer = db.transaction((from, to, amount) => {
	db.prepare("UPDATE account SET balance = balance - ? WHERE id = ?").run(amount, from);
	db.prepare("UPDATE account SET balance = balance + ? WHERE id = ?").run(amount, to);
});

transfer(1, 2, 50); // BEGIN, run, COMMIT; ROLLBACK if it throws
transfer.immediate(1, 2, 50); // BEGIN IMMEDIATE
```

The wrapper commits when the callback returns and rolls back (and rethrows) when it throws. Called while a transaction is already open, it uses a savepoint, so a nested failure undoes only its own part. `.deferred(...)`, `.immediate(...)` and `.exclusive(...)` pick the `BEGIN` mode; calling the wrapper directly is `BEGIN` (deferred). The callback must be synchronous: one that returns a promise is rolled back and throws.

### Errors

Every failure SQLite reports is a `sqlite.error` (alias `sqlite.err`):

```js
try {
	db.prepare("INSERT INTO note (id, body) VALUES (1, 'x')").run();
} catch (thrown) {
	if (thrown instanceof sqlite.error) {
		thrown.code; // "SQLITE_CONSTRAINT_PRIMARYKEY"
		thrown.number; // 1555, the extended result code
		thrown.sql; // the statement, when the failure came from one
	}
}
```

Argument mistakes are plain `TypeError`s and `RangeError`s. `sqlite.error` is one class across every entry, so an error thrown through `@cldmv/sqlite-wasm/worker` (where it is also `client.error`) or the Drizzle driver is an `instanceof sqlite.error` too.

### Aliases

| Name                                               | Alias        |
| -------------------------------------------------- | ------------ |
| `db.execute`                                       | `db.exec`    |
| `db.prepare`                                       | `db.prep`    |
| `db.transaction`                                   | `db.tx`      |
| `db.fn.aggregate`                                  | `db.fn.agg`  |
| `db.checkpoint`                                    | `db.ckpt`    |
| `statement.iterate` (also `statement.raw.iterate`) | `iter`       |
| `statement.columns`                                | `cols`       |
| `sqlite.error`                                     | `sqlite.err` |

## Storage and journal modes

### Storage

| `storage`          | Where                                      | Notes                                                                                       |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `"fs"`             | Real files, through synchronous `fs` calls | Node. `fsync` on the file, and on the directory after create and delete.                    |
| `"opfs"`           | The origin private file system             | Dedicated browser workers only. No COOP/COEP headers needed.                                |
| `"memory"`         | A growable buffer per file name            | Any environment. The data lives for the process, so reopening the same name finds it again. |
| `"auto"` (default) | `fs` in Node, `opfs` in a dedicated worker | Throws on a browser main thread, in shared workers and in service workers.                  |

The OPFS driver gets its synchronous handles before SQLite needs them: `open()` takes the database's Web Lock and opens handles for the database, its `-journal` and its `-wal`, and `attach()` does the same for the extra file. Temp files live in memory (`SQLITE_TEMP_STORE=3`). A second tab opening the same database waits up to `timeout` for the first to let go and then fails with `SQLITE_BUSY`; `timeout: 0` fails at once.

### Journal modes

```js
await sqlite.open("app.sqlite3", { journal: "wal", sync: "normal" }); // the defaults
```

| `journal`         | Behavior                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"wal"` (default) | Write-ahead log with `PRAGMA locking_mode = EXCLUSIVE` and `synchronous = NORMAL`.                                                                                                               |
| `"truncate"`      | Rollback journal that is truncated instead of deleted at the end of each transaction. The faster rollback mode on OPFS, since it avoids creating and deleting the journal file for every commit. |
| `"delete"`        | Rollback journal that is deleted at the end of each transaction.                                                                                                                                 |

WAL is the default because it is faster for most workloads and keeps readers out of the writer's way. SQLite normally needs a shared-memory index (`-shm`) for WAL, and there is no shared memory between wasm instances, processes or tabs. Exclusive locking mode makes SQLite keep that index in heap memory instead, which fits the model here: one connection owns a database and everything else goes through it. The consequence is that no other connection can use a WAL database while it is open here. Rollback modes switch back to normal locking, so locks are released between transactions.

The files stay standard SQLite. A clean `close()` checkpoints the WAL and removes the `-wal` file, after which native SQLite and `node:sqlite` open the database as usual. A file left in WAL mode (for example after a crash) opens here and recovers.

Use `sync: "full"` if every commit has to be synced.

## Locking

One connection owns a database at a time. Several processes (or tabs) writing the same file at once is not supported; the lock keeps them out.

### Node

Node has no `fcntl` locks, so opening a database takes an owner lock that lives outside the database file. A second process that opens the same database waits up to `timeout` milliseconds and then fails with `SQLITE_BUSY`. A lock whose process is gone (same host) is stale and is taken over. The `lock` option picks where it lives:

| `lock`               | Where                                                                   | Keeps two processes from writing at once?                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"beside"` (default) | A `<db>.lock/` folder next to the database                              | Yes. Also across machines on a shared folder, though a crashed remote owner's lock is removed by hand.                                                                                                                               |
| `"temp"`             | `<os.tmpdir()>/cldmv-sqlite-locks-<uid>/<sha256 of the real path>/`     | Yes, for one user on one machine. The folder is private to the user (mode 0700); opening refuses it if it is a symlink, owned by someone else, or writable by others. Other users, and a different `TMPDIR`, do not see these locks. |
| a folder path        | `<folder>/<sha256 of the real path>/`                                   | Yes, for every process that uses the same folder.                                                                                                                                                                                    |
| `"db"`               | A row in a `_cldmv_lock` table inside the database (pid, host, started) | Detects, does not prevent. Opening refuses with `SQLITE_BUSY` if the row names a live process on this host, but two processes opening in the same instant can both get through. A read-only open only checks and never writes.       |

`"beside"` falls back to `"temp"` when the lock folder cannot be created (a read-only database in a folder you cannot write), so read-only databases in read-only folders still open, protected. The folder kinds hash the file's real path, so two paths to one file (a symlink, `..`) share one lock. `db.info.lock` reports what is in effect.

Native SQLite does not know about these locks. Opening the same file with native SQLite while this library has it open is not supported; opening it before or after is.

### Browsers

The browser always uses the real lock: a Web Lock per database plus the browsers' own exclusive sync access handles. The `lock` option is ignored. `db.info.lock` is `"web"`.

## Browser: worker and host

The worker pair is one file on each side.

```js
// db-worker.mjs
import host from "@cldmv/sqlite-wasm/host";

host.listen(self, {
	// Optional. Runs after each open with the full synchronous API.
	setup(db) {
		db.fn.scalar("slug", (text) => text.toLowerCase().replaceAll(" ", "-"), { deterministic: true });
	}
});
```

```js
// page
import client from "@cldmv/sqlite-wasm/worker";

const db = await client.connect(new URL("./db-worker.mjs", import.meta.url), "app.sqlite3", {
	journal: "wal"
});
```

`client.connect(target, path, options?)` takes a worker script URL (a module worker is started, and terminated on `close()`), or a `Worker` or `MessagePort` that already runs the host. The options are `sqlite.open()`'s except that `storage` is `"opfs"` (the default) or `"memory"` and there is no `lock`; `share` is covered [below](#multi-tab-sharing).

`host.listen(scope, options?)` takes:

| Option      | Description                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wasm`      | Where `sqlite3.wasm` comes from: a URL, bytes, a `Response` or a compiled module. By default the package's own file next to the bundle. Bundlers that understand `new URL("./sqlite3.wasm", import.meta.url)` (Vite, webpack, Parcel) emit it as an asset; otherwise pass its URL. |
| `setup(db)` | Runs after each open with the synchronous `database`. Register functions and collations here, since they run in the worker. A throw fails the open.                                                                                                                                |
| `root`      | The OPFS directory databases live in; `navigator.storage.getDirectory()` by default.                                                                                                                                                                                               |
| `locks`     | The Web Locks manager; `navigator.locks` by default. `null` relies on the exclusive sync handles alone.                                                                                                                                                                            |
| `wait`      | Milliseconds to wait for another tab to close the database; defaults to `timeout`.                                                                                                                                                                                                 |

The client has the same surface as the synchronous API, with every call returning a promise: `prepare`/`prep`, `execute`/`exec`, `pragma`, `transaction`/`tx`, `attach`, `detach`, `backup`, `serialize`, `checkpoint`/`ckpt`, `close`, and `info` (`path`, `storage`, `lock`, `open`, `transaction`). Statements have `run`, `get`, `all`, `iterate` (async iterators), `raw`, `pluck`, `expand`, `bind`, `columns` and `close`.

A few things differ:

- `db.fn.*` throws on the client. Register functions in the host's `setup(db)`.
- A `transaction()` callback receives `tx`, whose `prepare`, `execute` and `pragma` join the transaction. Calls made without awaiting in between go out as one batch, and a callback that never awaits mid-way costs a single message. A transaction started inside another becomes a savepoint, so a failure there undoes only the savepoint.
- Calls made in the same tick travel as one message, and the host runs neighbouring independent statements inside one transaction so they share a single OPFS commit. Every call still gets its own result or error.
- `db.backup(target, { schema }?)` writes into the worker's storage, and `db.serialize()` transfers the bytes from the worker.
- `db.proxy(sql, params, method)` is a Drizzle `sqlite-proxy` callback over the connection.

Using a database from the main thread only for tests or scratch work is fine with `storage: "memory"`, since OPFS is not available there.

## Multi-tab sharing

Several tabs of the same origin can use one OPFS database at once. One tab owns it and the others go through that tab; ownership moves on its own when the owner closes or its worker ends.

```js
const db = await client.connect(new URL("./db-worker.mjs", import.meta.url), "app.sqlite3", { share: true });

db.info.leader; // true if this tab's worker holds the database
const stop = db.info.watch((leader) => console.log("leader:", leader));
```

How it works: every tab that connects asks for the Web Lock `sqlite:<path>:leader` and waits. The holder is the leader, and its dedicated worker opens the database. The other tabs are followers: they send requests to the leader over a `BroadcastChannel` named `sqlite:<path>`, and the leader runs them in its worker and broadcasts the answers. The browser releases the lock when the leader's tab dies, and the next waiting tab becomes the leader with no stale state. The API is the same in every tab; `db.info.leader` and `db.info.watch(listener)` (which returns a function that stops it) are the only differences.

Guarantees:

- Requests from one tab run in the order that tab sent them. Between tabs the order is whatever order they reach the leader.
- A transaction from any tab runs alone. While one tab's transaction is open, other tabs' requests wait for it. If that tab goes away mid-transaction, the leader rolls it back.
- Reads are retried against the new leader after a handover. A write the old leader never started is retried too. A write whose outcome is unknown, because the old leader began it and then went away, fails with `SQLITE_BUSY` ("the leader changed") rather than running twice. A transaction that began under the old leader is rolled back and its remaining calls reject with `SQLITE_BUSY`.
- A leader whose worker ends while its tab stays open (the browser killed it, it was terminated, or it threw an uncaught error, after which it is terminated) hands over the same way as if the tab had closed; see [a leader's worker ends](#when-a-leaders-worker-ends).
- A leader that closes keeps serving until its own earlier calls and any open follower transaction are done, then closes the database and releases the lock. Requests it did not pass on are resent to the next leader.

Caveats:

- Connection state lives in the leader's worker and does not move at a handover: attached databases, `PRAGMA` settings and functions registered outside the host's `setup` hook are gone in the new leader. Put anything you need to persist in `setup(db)`.
- Every tab must connect with the same path string, since the lock and channel names are derived from it.
- `share: true` needs the worker script's URL (not an existing `Worker` or `MessagePort`), because each tab that becomes the leader starts its own worker. It also needs Web Locks, `BroadcastChannel` and `Worker`, so it only works in a browser page.
- Sharing is between tabs of one origin. Sharing across origins, or with a service worker, is not supported.

### When a leader's worker ends

The leader's worker takes a Web Lock (`sqlite:<path>:worker:<id>`) when it starts and never lets it go, and the leader tab waits for that same lock. The browser releases a lock when its owner ends, however it ends, so the lock being granted to the tab means the worker is gone. An uncaught error in the worker counts as well: the tab terminates the worker and handles it the same way.

The tab then steps down as if it had closed:

- Writes its worker had already started reject with `SQLITE_BUSY` ("the leader changed"), since their outcome is unknown. A transaction that was open fails as rolled back.
- Reads and calls the worker had not started are resent through the new leader, and so are followers' requests.
- `db.info.leader` flips to `false` and `watch` listeners fire. The tab releases the leader lock and joins again as a follower under a new tab id, so the other tabs see a new leader even if this tab is elected again.
- If another tab is waiting, it becomes the leader and starts its own worker. If none is, this tab is elected again and starts a new worker, and `info.leader` goes back to `true`.

A worker that ends before the database is open fails the `connect()` with `SQLITE_CANTOPEN`. Connection state does not survive this either: see the first caveat above.

## Drizzle

`@cldmv/sqlite-wasm/drizzle` wraps a database for [Drizzle ORM](https://orm.drizzle.team). It needs `drizzle-orm` `^0.45.0` as a peer.

### Synchronous (Node, or inside a worker)

```js
import sqlite from "@cldmv/sqlite-wasm";
import { drizzle, migrate } from "@cldmv/sqlite-wasm/drizzle";
import * as schema from "./schema.js";

const db = drizzle(await sqlite.open("app.sqlite3"), { schema });

db.select().from(schema.note).all();
db.transaction((tx) => {
	tx.insert(schema.note).values({ body: "hello" }).run();
});
```

This goes through Drizzle's own better-sqlite3 session, so the query API is the one Drizzle documents for better-sqlite3: `.all()`, `.get()`, `.run()`, `.values()` and `db.transaction()` are synchronous. You do not need the native `better-sqlite3` package.

### Asynchronous (browser main thread)

```js
import client from "@cldmv/sqlite-wasm/worker";
import { drizzle } from "@cldmv/sqlite-wasm/drizzle";
import * as schema from "./schema.js";

const db = drizzle(await client.connect(new URL("./db-worker.mjs", import.meta.url), "app.sqlite3"), { schema });

await db.select().from(schema.note);
await db.query.note.findMany();
await db.transaction(async (tx) => {
	await tx.insert(schema.note).values({ body: "hello" });
});
await db.batch([db.insert(schema.note).values({ body: "a" }), db.insert(schema.note).values({ body: "b" })]);
```

A worker client goes through Drizzle's `sqlite-proxy` session. Transactions run through the client's own transaction queue, so concurrent ones do not interleave their `BEGIN` and `COMMIT`, and `db.batch()` runs its queries in one transaction in the worker.

`drizzle(db, config?)` takes `schema` (enables `db.query.*`), `logger` (`true` or a Drizzle logger) and `casing` (`"snake_case"` or `"camelCase"`). Drizzle's `cache` option is not supported. The original database or client is on `db.$client`.

### Migrations

Drizzle's own `migrate()` from `drizzle-orm/better-sqlite3/migrator` works on the synchronous result. It reads a folder, so it is for Node and workers with a file system. For migrations bundled as data (`{ journal, migrations }`, the shape drizzle-kit writes for its bundled drivers), use the `migrate()` from this package. It works for both kinds of database, so it serves the browser too:

```js
import { migrate } from "@cldmv/sqlite-wasm/drizzle";
import journal from "./drizzle/meta/_journal.json" with { type: "json" };
import m0000 from "./drizzle/0000_init.sql?raw"; // bundler-specific: any way of getting the SQL as a string

migrate(db, { journal, migrations: { m0000 } }); // synchronous database
await migrate(db, { journal, migrations: { m0000 } }); // worker client
```

Migrations are keyed `m0000`, `m0001`, and so on, matching the journal's `idx`. They run in one transaction.

### Browser caveat: `blob` columns need a `Buffer`

Drizzle's `blob` column types call the global `Buffer`: always in `buffer` mode, and when writing in `json` and `bigint` modes. Browsers do not have `Buffer` and Drizzle does not provide it. An app that uses those columns in a browser adds the [`buffer`](https://www.npmjs.com/package/buffer) package and installs it as a global before any query runs:

```js
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
```

Install this wherever Drizzle runs: the page for the async client, and the worker too if you use Drizzle there.

## What is compiled in

SQLite 3.54.1, built from SQLite's source archive with wasi-sdk 34 and optimized with binaryen. The amalgamation is generated from the archive by SQLite's own scripts (`make sqlite3.c`), with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` set so the generated parser accepts it. The build includes:

- FTS3, FTS4 (built together with FTS3) and FTS5, with `FTS3_PARENTHESIS`
- R\*Tree and Geopoly
- JSON functions (built in)
- the `dbstat` virtual table
- math functions
- `percentile` functions
- column metadata (`stmt.columns()` reports `table`, `column` and `database`)
- `UPDATE ... ORDER BY ... LIMIT` and `DELETE ... ORDER BY ... LIMIT` (`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`), which Drizzle's `update()` and `delete()` builders use for `.orderBy()` and `.limit()`
- STAT4 query-planner statistics

Defaults:

- foreign keys on, `DQS=0` (double-quoted strings are identifiers only; use single quotes for text), `LIKE` does not match BLOBs
- temp tables and indices in memory (`TEMP_STORE=3`), `synchronous=NORMAL` in WAL mode
- single-threaded build (`THREADSAFE=0`)

Left out: loadable extensions, UTF-16 APIs, shared cache, deprecated interfaces, the progress callback, TCL variables and `sqlite3_get_table`. `localtime` is UTC, because wasi-libc has no time zone database.

All connections in a process share one module instance, which is what lets `ATTACH` and `backup()` work between them.

## Requirements

- Node.js `>=20.19.0` at runtime (`engines`). The CommonJS entry relies on `require(esm)`, which needs `^20.19.0` or `>=22.13.0`.
- Working on this repository needs Node.js `>=22.22.0` (`devEngines`).
- Browsers: a dedicated worker with OPFS sync access handles for persistent storage, and WebAssembly. Multi-tab sharing also needs Web Locks and `BroadcastChannel`.

## Development

The source is TypeScript (`src/**/*.mts`) and the package ships built `dist/`. The wasm is built from source by `npm run build` (tsup, then `scripts/build-wasm.mjs`), which downloads pinned versions of SQLite's source archive, wasi-sdk and binaryen into `.cache/toolchains/` (override with `SQLITE_WASM_TOOLCHAIN_DIR`). The pins and hashes are in `sqlite.version.json`, and `npm run sqlite:bump` updates the SQLite pin. Generating the amalgamation needs `make` and a C compiler (`cc`, or `$CC`) on the build machine, which Linux and macOS have; nothing else, since the archive carries its own Tcl interpreter. The built `dist/sqlite3.wasm` is what gets published, so consumers need none of this.

To run from `src/` without building, resolve the `sqlite-wasm-dev` export condition, which points every entry at its `.mts` source:

```sh
node --conditions=sqlite-wasm-dev app.mts
```

(The wasm itself still has to be built once.)

Useful scripts: `npm run build`, `npm test` (Node tests, the CommonJS tests and the same tests against `dist/`), `npm run test:browser` (Chromium), `npm run coverage`, `npm run lint`, `npm run format`, `npm run types:check`.

## License

[Apache-2.0](LICENSE)
