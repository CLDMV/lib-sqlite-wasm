# `@cldmv/sqlite-wasm` design

This document describes how `@cldmv/sqlite-wasm` is built and why it is built that way. Usage is documented in the [README](../README.md); this document links to it rather than repeating it.

## Goal

One SQLite library that behaves the same in Node.js and in browsers, so an application doesn't need two storage stacks (for example `node-sqlite3-wasm` on Node and `@sqlite.org/sqlite-wasm` in the browser) with two feature sets.

- Real files on disk in Node, OPFS in a dedicated browser worker, memory anywhere.
- A synchronous API wherever the storage is synchronous (Node, browser workers), and an async client for the browser main thread.
- One set of compile options everywhere (FTS3/FTS4/FTS5, R\*Tree, Geopoly and the rest of [the list below](#compile-options)), so databases written by native SQLite open here and the other way round.
- WAL as the default journal mode.
- Drizzle ORM without a custom ORM layer.

The library is written from scratch. The only outside code in the module is SQLite itself, built from SQLite's own source archive at a pinned version and hash, with nothing patched. It is not a fork of another wasm SQLite project.

## Non-goals

- Several processes or tabs writing one database at the same time. One connection owns a database; everything else goes through it. Several tabs can share a database, but only by sending their requests to the one tab that owns it (see [Multi-tab sharing](#multi-tab-sharing)).
- Loadable extensions, the UTF-16 APIs and shared cache.
- Persistent storage on the browser main thread. OPFS sync access handles only exist in dedicated workers, so the main thread uses the worker client or `storage: "memory"`.
- Sharing a database across origins, or between a page and a service worker.

## Architecture

```text
            ┌──────────────────────────── JS ─────────────────────────────┐
 app ──▶    │ api/      sqlite.open, database, statement, fn, transaction │
            │ core/     loader, memory, values, errors, VFS router, WASI  │
            │ vfs/      fs  |  opfs  |  memory   (one driver interface)   │
            │ worker/   host, client, multi-tab coordinator               │
            └───────────────┬───────────────────────────────▲─────────────┘
                  exports   │                               │ imports (env.vfs_*, env.cb_*)
            ┌───────────────▼──────────── wasm ─────────────┴─────────────┐
            │ sqlite3.c (generated, unpatched)  +  glue.c (VFS, shims)    │
            └─────────────────────────────────────────────────────────────┘
```

### Toolchain: wasi-sdk, no Emscripten

The module is compiled with clang from wasi-sdk for `wasm32-wasip1` as a reactor module (`-mexec-model=reactor`, so it has no `main` and exports `_initialize`), with `-O3 -flto`, then optimized with binaryen's `wasm-opt -O3`. It imports only functions this library defines. The loader is ours too, so the same module and the same JS run in Node and browsers with no generated glue.

- SQLite is built with `SQLITE_OS_OTHER=1` and has no OS layer of its own: files, time, randomness and sleeping all go through our VFS.
- libc comes from wasi-libc. The only WASI function it still references is `random_get`, shimmed in `src/core/wasi.mts`. The loader checks every import of the module by name before instantiating and refuses anything it doesn't provide, so a toolchain or libc change that adds a WASI dependency fails loudly at load time.
- JS callbacks go through fixed C trampolines that call an imported JS function with a numeric id. Nothing in JS ever adds entries to the wasm function table, which would need `WebAssembly.Function` and isn't available everywhere.

Every existing wasm SQLite library uses Emscripten. Emscripten brings a large JS runtime, environment detection and its own file system layer that would mostly be switched off here. wasi-sdk is one tarball with no Python or Node dependency, which also keeps CI simple.

### Building from the source archive

`scripts/build-wasm.mjs` builds `dist/sqlite3.wasm`, driven entirely by `sqlite.version.json`:

1. Download SQLite's canonical source archive (`sqlite-src-<n>.zip`), verify its SHA3-256, and extract it (without the test suite).
2. Generate `sqlite3.c` and `sqlite3.h` with SQLite's own `Makefile.linux-generic`: `make sqlite3.c OPT_FEATURE_FLAGS=-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT`. This builds lemon, mkkeywordhash and the archive's bundled Jim Tcl interpreter with the host C compiler, regenerates the parser and runs `tool/mksqlite3c.tcl`.
3. Download wasi-sdk and binaryen for the host (Linux or macOS, x64 or arm64), verified against their SHA-256.
4. Compile `sqlite3.c` and `src/c/glue.c` with clang, then run `wasm-opt`.

The source archive is used instead of the published amalgamation because of `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (`UPDATE`/`DELETE ... ORDER BY ... LIMIT`, which Drizzle's `.orderBy()` and `.limit()` on updates and deletes need). That option changes the grammar. The published amalgamation ships a parser generated without it, so defining the macro while compiling it only adds the name to `PRAGMA compile_options` and the syntax stays an error. Running SQLite's own generators with the flag is the same pipeline sqlite.org uses for the released amalgamation, so nothing is patched or substituted by hand and no system `tclsh` is needed. The host needs `make` and a C compiler (`cc` or `$CC`), which Linux and macOS have. Only the parser-affecting flag is passed to generation; every other option is applied at compile time.

Downloads and unpacked toolchains live in `SQLITE_WASM_TOOLCHAIN_DIR` (default `.cache/toolchains/`, gitignored). The linked module is cached under `.cache/build/`, keyed by a hash of the pins, `glue.c`, the defines, the generator flags, the export list and the compiler, linker and `wasm-opt` flags, so a rebuild in the same checkout only copies it back. No shell is used: every tool runs through `spawnSync` with an argument array.

The wasm is built in CI from source on every build; nothing binary is committed. `npm run build` runs `scripts/build-js.mjs` and then `build:wasm`, in that order, because the JS build clears `dist/` first. `npm run sqlite:bump` (`scripts/bump-sqlite.mjs`) moves the SQLite pin, and `--toolchain` moves the wasi-sdk and binaryen pins.

### C glue

`src/c/glue.c` is the only C in the repository. It has five parts:

1. The `env.vfs_*` imports.
2. A `sqlite3_file` subclass and an `sqlite3_io_methods` table at version 1: no `xShm*` methods and no `xFetch`/`xUnfetch` (see [WAL without shared memory](#wal-without-shared-memory)). `xFileControl` returns `SQLITE_NOTFOUND` for every opcode.
3. The `sqlite3_vfs` named `cldmv` (version 2, for `xCurrentTimeInt64`), registered as the default by `sqlite3_os_init()`. The `xDl*` slots are empty because extension loading is compiled out.
4. Trampolines for user functions and collations. Each callback kind has one fixed C function, registered with the callback id as its user-data pointer; it calls the matching `env.cb_*` import with that id: `cb_func` (scalar call, aggregate and window step), `cb_final` (aggregate final, or window value), `cb_inverse`, `cb_collate` and `cb_destroy` (the function or collation was replaced, deleted or its connection closed). `cldmv_create_function` and `cldmv_create_collation` are the exported registration helpers; the collation helper calls the destroy trampoline itself on failure, because `sqlite3_create_collation_v2` doesn't, so JS always gets exactly one `cb_destroy` per id.
5. Exported helpers for what JS can't reach directly (macros, struct fields).

The SQLite functions the module exports are listed once, in `EXPORTS` in `scripts/build-wasm.mjs`, and typed in `SqliteExports` in `src/core/loader.mts`. There are no hooks (update, commit) and no busy-handler trampoline: lock waits use `sqlite3_busy_timeout`.

### The C ↔ JS VFS contract

Every VFS and file method in `glue.c` forwards to a synchronous import from the `env` module. Each returns an SQLite result code unless noted. 64-bit offsets and sizes travel as two 32-bit halves so the import signatures need no BigInt, and out-parameters are pointers into wasm memory that JS writes before returning.

| Import                                                                                                            | Purpose                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `vfs_open(name, file_id, flags, out_flags)`                                                                       | Open or create; JS maps the file id to the driver's file      |
| `vfs_delete(name, sync_dir)`, `vfs_access(name, flags, out)`, `vfs_fullpath(name, n, out)`                        | Name operations                                               |
| `vfs_read(file_id, buf, amount, offset_lo, offset_hi)`                                                            | A short read zero-fills and returns `SQLITE_IOERR_SHORT_READ` |
| `vfs_write(...)`, `vfs_truncate(file_id, size_lo, size_hi)`, `vfs_sync(file_id, flags)`, `vfs_size(file_id, out)` | Data operations                                               |
| `vfs_lock(file_id, level)`, `vfs_unlock(file_id, level)`, `vfs_check_reserved(file_id, out)`                      | SQLite's lock levels                                          |
| `vfs_close(file_id)`                                                                                              |                                                               |
| `vfs_sector_size(file_id)`, `vfs_device_characteristics(file_id)`                                                 | Plain values, not result codes                                |
| `vfs_randomness(n, out)`, `vfs_current_time_ms(out)`, `vfs_sleep(microseconds)`                                   | Provided by the core, not by drivers                          |

`src/core/vfs-imports.mts` implements these imports on top of the `VfsDriver` interface, and drivers never see wasm memory:

- Pointers and split offsets become strings, numbers and `Uint8Array` views. `read` and `write` get a view into wasm memory that the driver copies out of or into and never keeps, since any `malloc` can grow memory and detach it.
- `size`, `access`, `checkReserved`, `sectorSize` and `deviceCharacteristics` return plain values, and the core writes the out-parameters.
- `open(name, fileId, flags)` returns only a result code; the out-flags echo the input flags. `name` is null for a temporary file the driver names itself.
- A thrown exception must never unwind through wasm frames, so the core catches it, returns that method's I/O error code, and keeps the exception. The `sqlite.error` the API then throws carries it as its `cause`.
- `glue.c` numbers files per module instance; the core maps those to process-wide ids, so one driver object can serve several connections and never sees two files with one id.
- Randomness (`crypto.getRandomValues`), time (`Date.now()`) and sleep (`Atomics.wait`) live in the core. `Atomics.wait` works in Node and in workers, which is where the synchronous API runs.

### One module instance per process

Every connection in a process shares one module instance, created by the first `sqlite.open()` and cached (`src/api/runtime.mts`):

- `db.backup()` and `ATTACH` between connections only work when both live in the same SQLite library instance; `sqlite3_backup_init` takes two `sqlite3` handles.
- Each instance has its own linear memory (megabytes once the page cache warms up) and its own copy of SQLite's globals; one instance per connection multiplies that for nothing.
- The build is single-threaded (`SQLITE_THREADSAFE=0`) and so is JS, so connections never run concurrently.

The cost is that the instance's memory only grows, and a trap inside the module takes every connection in the process down with it.

Storage still differs per connection. An instance has exactly one VFS, so its driver is a router (`src/core/router.mts`). Before `sqlite3_open_v2` or `ATTACH`, the API registers the database's name with the driver it was opened with; SQLite's companion files (`-journal`, `-wal`, `-mj…` super-journals) are matched by prefix. Names are reference counted, so two connections to one database can each register and release it, and registering a name already routed to a different kind of storage fails with `SQLITE_CANTOPEN`. Unnamed temporary files, and names nobody registered, go to the shared memory driver.

### Storage drivers

A storage driver is a module with a `create(options)` factory returning a `VfsDriver`, optionally with three asynchronous hooks around SQLite's synchronous calls: `prepare(path, options)` before `sqlite3_open_v2` or `ATTACH` (it resolves to the name SQLite opens), `release(name)` after close or `DETACH`, and `held(name)` for `db.info.lock`. Drivers are imported on first use only (`src/vfs/registry.mts`), so Node never loads OPFS code and a browser bundle never reaches `node:fs`.

`storage: "auto"` (the default) resolves to `fs` in Node and `opfs` in a dedicated worker. Anywhere else there is no persistent synchronous storage, so `"auto"` throws an error that points at the worker client or `storage: "memory"`. `:memory:` and `""` always use memory. The user-facing table is in the [README](../README.md#storage).

**`fs` (Node, `src/vfs/fs.mts`).** Synchronous `node:fs` calls on real files. `xSync` uses `fdatasync` when SQLite asks for data only and `fsync` otherwise, and the directory is synced after a create and a delete. Locking works on two levels:

- Within the process, the lock levels SQLite asks for (shared, reserved, pending, exclusive) are tracked in JS per file and shared by every driver object, so two connections in one process arbitrate the way they would on disk.
- Across processes, Node has no `fcntl` locks, so `prepare()` takes an owner lock outside the database file: a directory holding `owner.json` (pid, host name, start time). The directory is built under a temporary name and renamed into place, so it appears atomically and always with its owner file. A live owner makes the open wait up to `timeout` and then fail with `SQLITE_BUSY`. An owner whose pid is dead on this host is stale and is taken over; taking over is itself serialized through a `reap` lock one level down, so two takers can't both remove it and a taker that finds a fresh owner backs off. Where the lock lives is the [lock option](#lock-option).
- Native SQLite doesn't know about the owner lock. Opening a database with native SQLite while this library has it open isn't supported; before or after is fine.

When the driver is used on its own (not through the router), unnamed temporary files go in a folder private to the process, made with `mkdtemp` (mode 0700) and removed at exit, with files created exclusively at mode 0600, because they hold database data.

**`opfs` (dedicated browser workers, `src/vfs/opfs.mts`).** `FileSystemSyncAccessHandle` is synchronous, which is what the VFS needs, but it can only be obtained asynchronously, and only one handle per file can exist at a time. Instead of a pool of anonymous handles, `prepare()` takes a Web Lock for the database (`sqlite-wasm:<name>`) and opens handles for the database, its `-journal` and its `-wal` before SQLite opens anything. `attach()` is async for the same reason: it prepares the attached file first. `release()` closes the handles, removes empty companion files and drops the lock.

- Every other file SQLite opens (temp databases, statement and super journals) lives in memory; the build uses `SQLITE_TEMP_STORE=3`.
- A companion file only "exists" for SQLite when it has content. `prepare()` has to create `-journal` and `-wal` to get handles on them, and an empty `-wal` reported as existing would switch a rollback-mode database to WAL. Deleting a companion truncates it instead, since its handle stays open.
- Database files report `SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN`.
- A second tab waits up to `timeout` (default 5000 ms) for the lock and then fails with `SQLITE_BUSY`; `timeout: 0` fails at once.
- No COOP/COEP headers are needed: sync access handles work in any dedicated worker.

**`memory` (`src/vfs/memory.mts`).** A growable buffer per file name, with lock levels tracked per open handle. There is one memory driver per process, so reopening a name finds its data again; it is also the router's fallback for temporary files.

### WAL without shared memory

WAL normally needs a shared index (`-shm`) mapped by every connection, and there is no shared memory between wasm instances, processes or tabs. With `PRAGMA locking_mode = EXCLUSIVE` set before the first WAL access, SQLite keeps that index in heap memory and never calls `xShm*`. That fits the one-connection-per-database model.

A file left in WAL mode only opens if exclusive locking is set before the first read; otherwise SQLite returns `SQLITE_CANTOPEN`, because there are no `xShm` methods. So `sqlite.open()` (`src/api/open.mts`) applies the settings in this order on every open:

1. `PRAGMA locking_mode = EXCLUSIVE`, before anything reads the file. This covers both a requested WAL journal and an existing file that is already in WAL mode.
2. `PRAGMA journal_mode = <journal>` (skipped on read-only connections, which can't change it).
3. If the resulting mode isn't WAL, `PRAGMA locking_mode = NORMAL`, so a rollback-journal connection releases its locks between transactions as usual.
4. `PRAGMA synchronous = <sync>` and `PRAGMA foreign_keys`.

The `journal` option is `"wal"` (default), `"truncate"` or `"delete"`, and `sync` defaults to `"normal"`. Rollback mode is offered as `TRUNCATE` because it reuses the journal file instead of creating and deleting it on every commit, which is the expensive part on OPFS. `sync: "full"` is there for callers that need every commit synced.

The files stay standard SQLite. A clean close checkpoints and removes `-wal`, after which native SQLite and `node:sqlite` open them as usual, and a file left in WAL mode after a crash opens here and recovers. A real shared-memory implementation (copying index pages through a `-shm` file at lock changes) would be possible if multi-connection WAL were ever needed; it is not in scope.

### Compile options

The options live in `SQLITE_DEFINES` in `scripts/build-wasm.mjs`, and `tests/core/sqlite.test.vitest.mjs` checks them against `PRAGMA compile_options`. The user-facing list is in the [README](../README.md#what-is-compiled-in).

- Enabled: `FTS3`, `FTS3_PARENTHESIS`, `FTS5`, `RTREE`, `GEOPOLY`, `DBSTAT_VTAB`, `MATH_FUNCTIONS`, `COLUMN_METADATA`, `STAT4`, `UPDATE_DELETE_LIMIT`, `PERCENTILE`. FTS4 is built together with FTS3, and JSON is built in by default.
- Defaults: `DEFAULT_FOREIGN_KEYS=1`, `DEFAULT_MEMSTATUS=0`, `DQS=0`, `TEMP_STORE=3`, `DEFAULT_WAL_SYNCHRONOUS=1`, `LIKE_DOESNT_MATCH_BLOBS`, `THREADSAFE=0`, `OS_OTHER=1`.
- Omitted: `LOAD_EXTENSION`, `UTF16`, `SHARED_CACHE`, `DEPRECATED`, `PROGRESS_CALLBACK`, `TCL_VARIABLE`, `GET_TABLE`.

`localtime` is UTC, because wasi-libc has no time zone database. Supporting it would need an `env` import for the local offset.

### API naming

Names follow the way slothlet designs its APIs: every name is one lowercase word, with no camelCase, no PascalCase and no abbreviations (`statement`, not `stmt`). `db` for the database handle and `fn` for user-defined functions are the accepted short names. Anything that would need two words becomes a namespace: `db.pragma.get`, `db.fn.scalar`, `statement.raw.all`, `db.info.path`. TypeScript type names follow the same rule (`database`, `statement`, `row`, `value`, `options`), and so do the classes (`sqlite.error`).

A few names have a short alias: the same function under a second name, not a wrapper, documented next to it. The aliases are assigned on the prototype (`database.prototype.prep = database.prototype.prepare`). The full list is in the [README](../README.md#aliases): `exec`, `prep`, `tx`, `fn.agg`, `ckpt`, `iter`, `cols` and `sqlite.err`.

### API behaviour

The behaviour follows `better-sqlite3`'s shape on purpose: it is what most Node SQLite code already expects, and Drizzle's own `better-sqlite3` session then works against it unchanged (see [Drizzle](#drizzle)). The surface itself is in the [README](../README.md#api).

- `sqlite.open(path, options)` is async (instantiation, driver preparation, OPFS handles, the owner lock). Everything after it is synchronous, except `attach()`, `detach()` and `backup()`, which prepare or release files through the driver hooks.
- Values: null, number, bigint, string (UTF-8, embedded NUL kept) and `Uint8Array` for blobs. A safe integer binds as INTEGER and any other number as REAL; booleans bind as 1 and 0; `undefined` binds NULL. INTEGER comes back as a number when it is in the safe range and as a bigint otherwise, or always as a bigint with `bigint: true` (per database, per statement or per function). A bigint outside 64 bits throws a `RangeError` instead of wrapping, and anything else (a `Date`, a plain object in a value position) is a `TypeError`.
- `statement.run()` returns `{ changes, rowid }`. `get()`, `all()` and `iterate()` throw a `TypeError` on a statement that returns no rows, as `better-sqlite3` does. `get()` resets the statement after the first row, so a half-read statement never holds a read lock, and a statement can't run again while its iterator is open.
- Statements are finalized by `close()`, by `db.close()`, and by a `FinalizationRegistry` as a safety net, so a forgotten statement can't keep the database locked.
- `db.transaction(callback)` returns a wrapper whose calls run in `BEGIN` (or `.deferred`, `.immediate`, `.exclusive`). A call made while a transaction is open uses a savepoint, so a nested failure rolls back only its own part. The callback must be synchronous: a returned promise rolls the transaction back and throws, because the commit would otherwise run before the awaited work.
- A user function or collation that throws makes the statement fail with that same exception: the handler reports the failure to SQLite with `sqlite3_result_error` so the statement stops, and `step()` rethrows the original exception.
- Every SQLite failure is one class, `sqlite.error`, with `code` (the extended result code's name, such as `SQLITE_CONSTRAINT_UNIQUE`), `number` (the extended code) and `sql`. SQLite has no API that returns a code's name, so `src/core/codes.mts` keeps the table, falling back to the primary code's name. Argument mistakes are plain `TypeError`s and `RangeError`s.

### Worker client

A browser main thread has no synchronous storage, so the database runs in a dedicated worker. `@cldmv/sqlite-wasm/host` is the worker side (`host.listen(self, { wasm, root, locks, wait, setup })`) and `@cldmv/sqlite-wasm/worker` is the main-thread client (`client.connect(target, path, options)`), with the same methods returning promises. Usage is in the [README](../README.md#browser-worker-and-host).

- The host owns one connection, opened with `sqlite.open()` on OPFS by default, and answers requests in arrival order. Statements are prepared once per SQL text and kept in a 64-entry LRU cache, since the client sends SQL text rather than statement handles.
- Calls the client makes in the same tick travel as one message. Requests that pile up while the host is busy are merged, and neighbouring `INSERT`/`UPDATE`/`DELETE`/`SELECT` statements from independent calls run inside one transaction, so they cost one OPFS commit instead of one each. Every call still gets its own result or error.
- While a client `transaction()` callback runs, every call on the connection joins that transaction. A callback that never awaits mid-way costs a single message: `BEGIN`, its statements and `COMMIT` together. A transaction started inside another becomes a savepoint; a failure there undoes only the savepoint.
- User-defined functions and collations run in the worker, so `db.fn.*` on the client throws; they are registered in the host's `setup(db)` hook, which runs after every open.
- Values cross with the structured clone algorithm, which keeps bigint, `Uint8Array` and null as they are. A serialized database's buffer is transferred, not copied.
- The wasm is fetched and compiled with `WebAssembly.compileStreaming` from `new URL("./sqlite3.wasm", import.meta.url)`, the pattern Vite, webpack and Parcel recognise as an asset. The host's `wasm` option takes a URL, bytes, a `Response` or a compiled module when the file is served from elsewhere.
- Errors are reconstructed on the client as the same `sqlite.error` class; `client.error` is that class.

### Multi-tab sharing

With `client.connect(worker, path, { share: true })`, several tabs of one origin use one OPFS database. One tab owns it and the others go through that tab, and ownership moves on its own when the owner goes away. The implementation is `src/worker/share.mts`; the user-facing behaviour is in the [README](../README.md#multi-tab-sharing).

- **Leader election with Web Locks.** Every tab asks for the lock `sqlite:<path>:leader` and waits. The holder is the leader: it starts its own dedicated worker, which opens the database as an unshared connection would. The browser releases the lock when the tab dies, so the next waiting tab becomes leader with no stale state to clean up.
- **Followers talk over a BroadcastChannel** (`sqlite:<path>`) with the same request and response protocol as the worker client. Each message names the tab it is for or from, and a request is addressed to the leader the follower currently knows, so it reaches each leader at most once. No `MessagePort` transfer is needed. SharedWorker isn't used because sync access handles only exist in dedicated workers.
- **Same API in every tab.** The coordinator stands where the worker would be, so leader and follower look the same, apart from `db.info.leader` and `db.info.watch(listener)`, which reports changes and returns a stop function.
- **Transactions** hold the leader: while one tab's transaction is open, other tabs' requests wait, so a transaction that awaits results mid-way still runs alone. Each tab holds `sqlite:<path>:tab:<id>` for its lifetime and the leader waits on it, so a tab that dies mid-transaction gets its transaction rolled back.
- **Handover.** Before it runs a follower's write, the leader broadcasts `started`. After a handover, a follower resends what the old leader never answered, except writes it saw `started` for: those may or may not have been applied, so they fail with `SQLITE_BUSY` ("the leader changed") instead of running twice. Reads (`SELECT` and `VALUES` statements, column lists, `serialize`) are always resent. What is left of a transaction begun with the old leader rejects with `SQLITE_BUSY` ("rolled back"), and its `ROLLBACK` succeeds.
- **Ordering.** Requests from one tab run in the order it sent them; between tabs, in the order they reach the leader.
- **Closing.** A leader that closes keeps serving until its own earlier calls and any open follower transaction are done, answers everything it passed to its worker, closes the database and releases the lock. Follower requests it didn't pass on are resent to the next leader.
- **The leader's worker ends while its tab stays open** (the browser killed it, it was terminated, or it reported an uncaught error, after which the leader terminates it). The worker takes the lock `sqlite:<path>:worker:<id>` when it starts and never releases it, and the leader waits on it, so the grant is the signal that the worker is gone however it ended; the `error` event is a second signal. The leader then hands over as if its tab had closed: it stops answering, releases the leader lock and joins again as a follower under a new tab id, so followers see a new leader even when the same tab is elected again. Its own calls follow the follower rules. If the worker ends before the database is open, the open fails with `SQLITE_CANTOPEN` and the next tab tries.
- Connection state (attached databases, pragma settings, functions registered outside `setup`) lives in the leader's worker and doesn't move with a handover.

### Lock option

On Node, the `lock` option of `sqlite.open()` picks where the owner lock lives. Browsers always use the real lock (the database's Web Lock plus the browser's exclusive sync access handles) and ignore it.

| `lock`               | Where                                                                   | Keeps two processes from writing at once?                                                       |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `"beside"` (default) | `<db>.lock/` next to the database                                       | Yes, also across machines on a shared folder (a crashed remote owner's lock is removed by hand) |
| `"temp"`             | `<os.tmpdir()>/cldmv-sqlite-locks-<uid>/<sha256 of the real path>/`     | Yes, for one user on one machine                                                                |
| a folder path        | `<folder>/<sha256 of the real path>/`                                   | Yes, for every process that uses the same folder                                                |
| `"db"`               | A row in a `_cldmv_lock` table inside the database (pid, host, started) | Detects, doesn't prevent                                                                        |

- `"beside"` falls back to `"temp"` when the lock folder can't be created (a read-only database in a folder the process can't write), so read-only databases in read-only folders still open, protected.
- The `"temp"` root is private to the user: created with mode 0700, and refused if it is a symlink, isn't a directory, belongs to another user, or is group- or world-writable. A shared, unchecked folder under the temp directory would let another local user plant or remove locks. Where there are no uids (Windows) it is `cldmv-sqlite-locks/`, unchecked.
- The folder kinds hash the file's resolved real path, so two paths to one file (a symlink, `..`) share one lock.
- `"db"` exists for places where no folder can be written. On open it waits up to `timeout` while a row names another live process on this host and then refuses with `SQLITE_BUSY`; a writable open then removes stale rows (dead processes, other hosts) and adds its own, which close removes. A read-only open only checks. Two processes opening in the same instant can both pass, which is why it is documented as detecting a second process rather than preventing one. `backup()` clears the rows in the copy, since the copy isn't held by anyone.
- `db.info.lock` reports what is in effect: `"beside"`, `"temp"` (also when `"beside"` fell back), the folder, `"db"`, `"web"` (OPFS) or `"none"` (memory).

### Drizzle

`@cldmv/sqlite-wasm/drizzle` exports `drizzle()`, `migrate()` and `bytes()` (`src/drizzle.mts`), with `drizzle-orm` `^0.45.0` as an optional peer dependency.

- A database from `sqlite.open()` is driven by Drizzle's own `better-sqlite3` session. `drizzle-orm/better-sqlite3` itself can't be imported without the native `better-sqlite3` package, but its session module only calls `prepare()`, `transaction()` and a statement's `run`, `all`, `get` and `raw()`, so a small adapter over our database is all it needs. This is the reason the API keeps `better-sqlite3`'s behaviour.
- A worker client goes through Drizzle's `sqlite-proxy` session with `db.proxy`, plus a `batch` callback and a `transaction()` that runs through the client's own transactions, which queue concurrent ones instead of interleaving their `BEGIN` and `COMMIT`.
- Drizzle's folder-based migrator works on the synchronous database as is, but it reads the file system. `migrate()` here takes migrations bundled as data (`{ journal, migrations }`, the shape drizzle-kit writes for its bundled drivers) and works for both kinds of database, so it also serves the browser.
- `bytes()` is a `customType` blob column whose value is a plain `Uint8Array`. Drizzle's own `blob()` modes call Node's `Buffer`, which browsers don't have; blobs already come back from the database and through the worker as `Uint8Array`, so `bytes()` passes them through and needs no polyfill.

### Package layout

```text
src/c/glue.c                  C glue (VFS, trampolines, exported helpers)
src/core/                     loader (Node and browser), memory, callbacks, codes, VFS imports and router, WASI shim, platform
src/vfs/{fs,opfs,memory}.mts  storage drivers; registry.mts loads them on demand
src/api/                      open, database, statement, functions, transaction, values, error, runtime
src/worker/                   host, client, engine, protocol, share (multi-tab)
src/index.mts, src/index.cjs  main entry and its CommonJS wrapper
src/node.mts                  the Node-only capabilities the main entry provides
src/drizzle.mts, src/drizzle.cjs
scripts/build-wasm.mjs        source archive, toolchains, compile, wasm-opt
scripts/bump-sqlite.mjs       moves the pins in sqlite.version.json
sqlite.version.json           SQLite version, URL, size, SHA3-256; wasi-sdk and binaryen per-host assets and SHA-256
dist/                         build output: one .mjs per src/ module, CJS wrappers, sqlite3.wasm
types/                        generated declarations
```

Exports:

| Export      | Source                  | Formats     |
| ----------- | ----------------------- | ----------- |
| `.`         | `src/index.mts`         | ESM and CJS |
| `./host`    | `src/worker/host.mts`   | ESM         |
| `./worker`  | `src/worker/client.mts` | ESM         |
| `./drizzle` | `src/drizzle.mts`       | ESM and CJS |

Each export has a `sqlite-wasm-dev` condition with `types` and `import` pointing at its `.mts` source, so a checkout runs from `src/` with `--conditions=sqlite-wasm-dev`. `require` always resolves to `dist/`, so the CommonJS tests build first.

**TypeScript.** Sources are `src/**/*.mts`, on TypeScript 6 with `strict`, `module`/`moduleResolution` `NodeNext`, imports written with `.mts` extensions and `rewriteRelativeImportExtensions`, and `erasableSyntaxOnly`, so Node's own type stripping can run `src/` directly (no enums, namespaces or parameter properties). `tsc` compiles `dist/` (`scripts/build-js.mjs`), checks types (`types:check`) and emits declarations into `types/` (`types:build`). `types/` is generated at build and pack time rather than committed. The C glue stays C.

**One file per module, no bundling.** `dist/` mirrors `src/`: `tsc` compiles each `.mts` to a `.mjs` at the same path (rewriting the import extensions), and esbuild then minifies each file in place with `keepNames` (stack traces and `fn.name` stay readable), with source maps back to `src/`. Nothing is bundled, so every module (the error class, the protocol, values, the loader) exists once and the four entries share it by plain relative imports: `instanceof` works across entries (`client.error === sqlite.error`). Bundling the entries separately would give each its own copy of the shared code and break that; bundling them together needs code splitting, which leaves hashed `chunk-*.mjs` files nobody can read. Apps that bundle handle the per-module files as usual.

**No `node:` imports in shared code.** The browser entries share modules with the Node entry, so they can't get stubs of their own, and a `node:` import anywhere in the shared code would land in their graph. Node-only code (reading the wasm from disk, the `fs` driver, the `"db"` lock's process checks) sits behind `src/core/platform.mts`, which `src/node.mts` fills in. Only the main entry imports `src/node.mts`, and it passes the capabilities as an export rather than through an import side effect, because the package declares `"sideEffects": false`. `tests/bundle/browser.test.vitest.mjs` checks that the browser entries' import graph reaches no Node import, and that `dist/` has exactly one `.mjs` per source module.

**CommonJS.** `src/index.cjs` and `src/drizzle.cjs` are the generic CLDMV CommonJS shim (it returns what `import` gives, here the module object), copied verbatim into `dist/`, never a second bundle. They rely on Node's synchronous `require(esm)` and refuse with a clear message where it is missing. Because of that, no module in the ESM graph may use top-level `await`: nothing runs at import time, and the wasm is compiled on the first `sqlite.open()` and cached.

Runtime floor: Node.js `>=20.19.0` (`engines`); the CommonJS entries need `^20.19.0` or `>=22.13.0`. The development floor is `>=22.22.0` (`devEngines`). There are no runtime dependencies.

## Testing

Tests run through `@cldmv/vitest-runner` (`npm test`, `npm run coverage`), which runs each file in its own process. Coverage of `src/` is held at 100% lines, branches, functions and statements; a drop fails CI. `npm test` also runs the CommonJS tests (`node --test` against the built wrappers) and the same suite against `dist/` (`test:dist`).

- **Core and API:** the loader's import check, the VFS imports and router, values, statements, functions, transactions, every open option, and every compile option (FTS3/FTS4/FTS5 queries, R\*Tree, Geopoly, `dbstat`, `UPDATE ... LIMIT`), checked against `PRAGMA compile_options`.
- **`fs` driver:** WAL and both rollback modes; integrity after a child process is killed with `SIGKILL` mid-transaction (reopen, `PRAGMA integrity_check`); the owner lock between real processes; stale-lock takeover; every `lock` kind and the `"beside"` to `"temp"` fallback; the takeover race windows, played in by wrapping `node:fs`; files written here and read by `node:sqlite` and the other way round.
- **OPFS, worker and multi-tab logic in Node:** against an OPFS fake and a fake of several tabs of one origin (`tests/fakes/`), each with its own Web Locks client, BroadcastChannels and workers, and a `kill()` that behaves like a closed tab. This is what lets the handover rules reach 100% coverage.
- **Browser:** vitest browser mode with Playwright on headless Chromium (`npm run test:browser`, a separate CI job): real OPFS, the worker client, Drizzle through the client, and multi-tab sharing with same-origin iframes as tabs, including closing the leader mid-stream and ending the leader's worker while its tab stays open.
- **Drizzle:** one set of scenarios (schema, migrations, queries, transactions, update and delete with `orderBy` and `limit`) run on the synchronous database, through the worker client, and on a follower tab of a shared connection.
- **Package:** the `dist/` layout, the browser entries' import graph, shared module identity across entries, and the packed file list.

## Key decisions

- **wasi-sdk and our own loader instead of Emscripten.** No large runtime or generated glue, one module and one JS for every environment, and a simple CI toolchain.
- **Build from SQLite's source archive.** It is the only way to get `UPDATE`/`DELETE ... LIMIT` without patching anything, and it is the same generator pipeline sqlite.org uses.
- **The wasm is built in CI from pinned, hash-checked sources; nothing binary is committed.** The published package ships the built `dist/sqlite3.wasm`, so consumers need no toolchain.
- **One connection owns a database.** It makes WAL possible without shared memory, keeps locking simple, and matches how the target applications already work (one owner, everything else over RPC). Multi-tab sharing keeps this model by routing every tab through one owner.
- **WAL by default, in exclusive locking mode,** with `truncate` and `delete` available. Exclusive mode keeps the WAL index in heap memory, and setting it first is also what lets an existing WAL file open.
- **One module instance per process,** with a VFS router, so `ATTACH` and `backup()` work between connections and memory isn't multiplied per connection.
- **OPFS handles opened before SQLite needs them,** instead of a pool of anonymous handles, which keeps real file names in OPFS and needs no COOP/COEP headers.
- **An owner lock outside the file in Node,** because Node has no `fcntl` locks, with a choice of where it lives for read-only folders, shared folders and folder-less setups.
- **`better-sqlite3` behaviour with slothlet-style names.** Familiar semantics and Drizzle's own session without a custom layer, under one-word names with namespaces.
- **One error class for everything SQLite reports,** shared by every entry because each module is built once.
- **ESM first with thin CommonJS wrappers,** and no top-level `await` anywhere, so `require()` works without a second bundle.
