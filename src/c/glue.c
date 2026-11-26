/*
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/c/glue.c
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:12-08:00 (1795642212)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/*
 * @cldmv/sqlite-wasm: C glue between the SQLite amalgamation and the JS host.
 *
 * Built with wasi-sdk for wasm32-wasip1 (no emscripten). SQLite is compiled with SQLITE_OS_OTHER=1, so it has no
 * built-in OS layer: this file supplies sqlite3_os_init()/sqlite3_os_end() and registers one VFS, "cldmv", as the
 * default. Every VFS and file method forwards to a synchronous function imported from the host under the "env" module
 * (see "The C <-> JS VFS contract" in the design). The host keeps a file_id -> handle map; C never sees a JS object.
 *
 * Conventions for the imports:
 *   - Return an SQLite result code unless noted.
 *   - 64-bit offsets and sizes are passed as two 32-bit halves (lo, hi) so the host never needs BigInt for them.
 *   - Out-parameters are pointers into wasm memory that the host writes before returning.
 *
 * Layout of this file:
 *   1. Host imports (env.vfs_*)
 *   2. sqlite3_file subclass and io methods (version 1: no xShm*, no xFetch; WAL runs with locking_mode=EXCLUSIVE)
 *   3. sqlite3_vfs methods and registration (sqlite3_os_init / sqlite3_os_end)
 *   4. Trampolines for JS callbacks (user functions, aggregates, window functions, collations)
 *   5. Exported helpers for things the host cannot reach directly (macros, struct fields)
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "sqlite3.h"

#define CLDMV_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define CLDMV_EXPORT(name) __attribute__((export_name(#name), used))

/* ------------------------------------------------------------------------------------------------------------------ */
/* 1. Host imports                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

CLDMV_IMPORT(vfs_open) int vfs_open(const char *name, int file_id, int flags, int *out_flags);
CLDMV_IMPORT(vfs_delete) int vfs_delete(const char *name, int sync_dir);
CLDMV_IMPORT(vfs_access) int vfs_access(const char *name, int flags, int *out);
CLDMV_IMPORT(vfs_fullpath) int vfs_fullpath(const char *name, int n_out, char *out);
CLDMV_IMPORT(vfs_read) int vfs_read(int file_id, void *buf, int amount, int offset_lo, int offset_hi);
CLDMV_IMPORT(vfs_write) int vfs_write(int file_id, const void *buf, int amount, int offset_lo, int offset_hi);
CLDMV_IMPORT(vfs_truncate) int vfs_truncate(int file_id, int size_lo, int size_hi);
CLDMV_IMPORT(vfs_sync) int vfs_sync(int file_id, int flags);
CLDMV_IMPORT(vfs_size) int vfs_size(int file_id, sqlite3_int64 *out);
CLDMV_IMPORT(vfs_lock) int vfs_lock(int file_id, int level);
CLDMV_IMPORT(vfs_unlock) int vfs_unlock(int file_id, int level);
CLDMV_IMPORT(vfs_check_reserved) int vfs_check_reserved(int file_id, int *out);
CLDMV_IMPORT(vfs_close) int vfs_close(int file_id);
/* Returns the sector size in bytes, not a result code. */
CLDMV_IMPORT(vfs_sector_size) int vfs_sector_size(int file_id);
/* Returns a SQLITE_IOCAP_* bit mask, not a result code. */
CLDMV_IMPORT(vfs_device_characteristics) int vfs_device_characteristics(int file_id);
/* Returns the number of bytes written. */
CLDMV_IMPORT(vfs_randomness) int vfs_randomness(int n, char *out);
/* Writes the current time as Julian day number * 86400000 (what xCurrentTimeInt64 expects). */
CLDMV_IMPORT(vfs_current_time_ms) int vfs_current_time_ms(sqlite3_int64 *out);
/* Returns the number of microseconds actually slept. */
CLDMV_IMPORT(vfs_sleep) int vfs_sleep(int microseconds);

#define LO32(v) ((int)((sqlite3_uint64)(v) & 0xffffffffu))
#define HI32(v) ((int)((sqlite3_uint64)(v) >> 32))

/* ------------------------------------------------------------------------------------------------------------------ */
/* 2. File and io methods                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

typedef struct CldmvFile {
	sqlite3_file base; /* must be first */
	int id;
} CldmvFile;

static int next_file_id = 1;

static int cldmv_close(sqlite3_file *f) {
	return vfs_close(((CldmvFile *)f)->id);
}

static int cldmv_read(sqlite3_file *f, void *buf, int amount, sqlite3_int64 offset) {
	return vfs_read(((CldmvFile *)f)->id, buf, amount, LO32(offset), HI32(offset));
}

static int cldmv_write(sqlite3_file *f, const void *buf, int amount, sqlite3_int64 offset) {
	return vfs_write(((CldmvFile *)f)->id, buf, amount, LO32(offset), HI32(offset));
}

static int cldmv_truncate(sqlite3_file *f, sqlite3_int64 size) {
	return vfs_truncate(((CldmvFile *)f)->id, LO32(size), HI32(size));
}

static int cldmv_sync(sqlite3_file *f, int flags) {
	return vfs_sync(((CldmvFile *)f)->id, flags);
}

static int cldmv_file_size(sqlite3_file *f, sqlite3_int64 *out) {
	return vfs_size(((CldmvFile *)f)->id, out);
}

static int cldmv_lock(sqlite3_file *f, int level) {
	return vfs_lock(((CldmvFile *)f)->id, level);
}

static int cldmv_unlock(sqlite3_file *f, int level) {
	return vfs_unlock(((CldmvFile *)f)->id, level);
}

static int cldmv_check_reserved(sqlite3_file *f, int *out) {
	return vfs_check_reserved(((CldmvFile *)f)->id, out);
}

static int cldmv_file_control(sqlite3_file *f, int op, void *arg) {
	(void)f;
	(void)op;
	(void)arg;
	return SQLITE_NOTFOUND;
}

static int cldmv_sector_size(sqlite3_file *f) {
	return vfs_sector_size(((CldmvFile *)f)->id);
}

static int cldmv_device_characteristics(sqlite3_file *f) {
	return vfs_device_characteristics(((CldmvFile *)f)->id);
}

/* iVersion 1: no xShmMap/xShmLock/xShmBarrier/xShmUnmap and no xFetch/xUnfetch. SQLite then only allows WAL when the
 * connection is in exclusive locking mode, where the WAL index lives in heap memory. */
static const sqlite3_io_methods cldmv_io_methods = {
    1,
    cldmv_close,
    cldmv_read,
    cldmv_write,
    cldmv_truncate,
    cldmv_sync,
    cldmv_file_size,
    cldmv_lock,
    cldmv_unlock,
    cldmv_check_reserved,
    cldmv_file_control,
    cldmv_sector_size,
    cldmv_device_characteristics,
    0, /* xShmMap */
    0, /* xShmLock */
    0, /* xShmBarrier */
    0, /* xShmUnmap */
    0, /* xFetch */
    0, /* xUnfetch */
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* 3. VFS methods and registration                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

static int cldmv_open(sqlite3_vfs *vfs, sqlite3_filename name, sqlite3_file *file, int flags, int *out_flags) {
	(void)vfs;
	CldmvFile *f = (CldmvFile *)file;
	int out = flags;
	f->base.pMethods = 0;
	f->id = next_file_id++;
	int rc = vfs_open(name, f->id, flags, &out);
	if (rc != SQLITE_OK) return rc;
	if (out_flags) *out_flags = out;
	f->base.pMethods = &cldmv_io_methods;
	return SQLITE_OK;
}

static int cldmv_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
	(void)vfs;
	return vfs_delete(name, sync_dir);
}

static int cldmv_access(sqlite3_vfs *vfs, const char *name, int flags, int *out) {
	(void)vfs;
	return vfs_access(name, flags, out);
}

static int cldmv_full_pathname(sqlite3_vfs *vfs, const char *name, int n_out, char *out) {
	(void)vfs;
	return vfs_fullpath(name, n_out, out);
}

static int cldmv_randomness(sqlite3_vfs *vfs, int n, char *out) {
	(void)vfs;
	return vfs_randomness(n, out);
}

static int cldmv_sleep(sqlite3_vfs *vfs, int microseconds) {
	(void)vfs;
	return vfs_sleep(microseconds);
}

static int cldmv_current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *out) {
	(void)vfs;
	return vfs_current_time_ms(out);
}

static int cldmv_current_time(sqlite3_vfs *vfs, double *out) {
	sqlite3_int64 ms = 0;
	int rc = cldmv_current_time_int64(vfs, &ms);
	*out = ms / 86400000.0;
	return rc;
}

static int cldmv_get_last_error(sqlite3_vfs *vfs, int n, char *out) {
	(void)vfs;
	if (n > 0) out[0] = 0;
	return 0;
}

static sqlite3_vfs cldmv_vfs = {
    2,                    /* iVersion: adds xCurrentTimeInt64 */
    sizeof(CldmvFile),    /* szOsFile */
    1024,                 /* mxPathname */
    0,                    /* pNext */
    "cldmv",              /* zName */
    0,                    /* pAppData */
    cldmv_open,           /* xOpen */
    cldmv_delete,         /* xDelete */
    cldmv_access,         /* xAccess */
    cldmv_full_pathname,  /* xFullPathname */
    0,                    /* xDlOpen: extension loading is compiled out */
    0,                    /* xDlError */
    0,                    /* xDlSym */
    0,                    /* xDlClose */
    cldmv_randomness,     /* xRandomness */
    cldmv_sleep,          /* xSleep */
    cldmv_current_time,   /* xCurrentTime */
    cldmv_get_last_error, /* xGetLastError */
    cldmv_current_time_int64, /* xCurrentTimeInt64 */
    0,                    /* xSetSystemCall */
    0,                    /* xGetSystemCall */
    0,                    /* xNextSystemCall */
};

int sqlite3_os_init(void) {
	return sqlite3_vfs_register(&cldmv_vfs, 1);
}

int sqlite3_os_end(void) {
	return SQLITE_OK;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 4. Trampolines for JS callbacks                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */
/*
 * Each callback kind has one fixed C function that SQLite calls; it forwards to an imported JS dispatcher with a
 * numeric callback id, so JS never has to add entries to the wasm function table. The id travels as the user-data
 * pointer (pApp / pArg) cast through intptr_t. JS keeps id -> callback and drops the entry when cb_destroy runs.
 *
 *   env.cb_func(id, ctx, argc, argv)       scalar function call, aggregate and window step
 *   env.cb_final(id, ctx, final)           aggregate final (final = 1) or window value (final = 0)
 *   env.cb_inverse(id, ctx, argc, argv)    window inverse
 *   env.cb_destroy(id)                     the function or collation was replaced, deleted or its connection closed
 *   env.cb_collate(id, n1, p1, n2, p2)     collation compare; returns <0, 0 or >0
 *
 * A JS exception never unwinds through these frames: the JS side catches it, reports it with sqlite3_result_error (or
 * returns 0 from a collation) and rethrows it once the statement step returns.
 */

CLDMV_IMPORT(cb_func) void cb_func(int id, sqlite3_context *ctx, int argc, sqlite3_value **argv);
CLDMV_IMPORT(cb_final) void cb_final(int id, sqlite3_context *ctx, int final);
CLDMV_IMPORT(cb_inverse) void cb_inverse(int id, sqlite3_context *ctx, int argc, sqlite3_value **argv);
CLDMV_IMPORT(cb_destroy) void cb_destroy(int id);
CLDMV_IMPORT(cb_collate) int cb_collate(int id, int n1, const void *p1, int n2, const void *p2);

#define CALLBACK_ID(pointer) ((int)(intptr_t)(pointer))

static void tramp_func(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
	cb_func(CALLBACK_ID(sqlite3_user_data(ctx)), ctx, argc, argv);
}

static void tramp_final(sqlite3_context *ctx) {
	cb_final(CALLBACK_ID(sqlite3_user_data(ctx)), ctx, 1);
}

static void tramp_value(sqlite3_context *ctx) {
	cb_final(CALLBACK_ID(sqlite3_user_data(ctx)), ctx, 0);
}

static void tramp_inverse(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
	cb_inverse(CALLBACK_ID(sqlite3_user_data(ctx)), ctx, argc, argv);
}

static void tramp_destroy(void *user) {
	cb_destroy(CALLBACK_ID(user));
}

static int tramp_collate(void *user, int n1, const void *p1, int n2, const void *p2) {
	return cb_collate(CALLBACK_ID(user), n1, p1, n2, p2);
}

/* Function kinds for cldmv_create_function. */
#define CLDMV_SCALAR 0
#define CLDMV_AGGREGATE 1
#define CLDMV_WINDOW 2

/* Registers a user function backed by JS callback `id`. sqlite3_create_function_v2 and
 * sqlite3_create_window_function call xDestroy themselves when they fail, so JS always gets its cb_destroy. */
CLDMV_EXPORT(cldmv_create_function)
int cldmv_create_function(sqlite3 *db, const char *name, int argc, int flags, int id, int kind) {
	void *user = (void *)(intptr_t)id;
	switch (kind) {
	case CLDMV_SCALAR:
		return sqlite3_create_function_v2(db, name, argc, flags, user, tramp_func, 0, 0, tramp_destroy);
	case CLDMV_AGGREGATE:
		return sqlite3_create_function_v2(db, name, argc, flags, user, 0, tramp_func, tramp_final, tramp_destroy);
	default:
		return sqlite3_create_window_function(db, name, argc, flags, user, tramp_func, tramp_final, tramp_value,
		                                      tramp_inverse, tramp_destroy);
	}
}

/* Registers a UTF-8 collation backed by JS callback `id`. Unlike the function APIs, sqlite3_create_collation_v2 does not
 * call xDestroy when it fails, so this does it to keep the JS side's bookkeeping in one place. */
CLDMV_EXPORT(cldmv_create_collation) int cldmv_create_collation(sqlite3 *db, const char *name, int id) {
	void *user = (void *)(intptr_t)id;
	int rc = sqlite3_create_collation_v2(db, name, SQLITE_UTF8, user, tramp_collate, tramp_destroy);
	if (rc != SQLITE_OK) tramp_destroy(user);
	return rc;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 5. Exported helpers                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/* SQLITE_TRANSIENT is a macro ((sqlite3_destructor_type)-1); JS passes -1 directly, so nothing is needed for it here. */

/* The SQLite version string compiled into this module (same as sqlite3_libversion(), kept for a cheap smoke test). */
CLDMV_EXPORT(cldmv_sqlite_version_number) int cldmv_sqlite_version_number(void) {
	return SQLITE_VERSION_NUMBER;
}
