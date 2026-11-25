/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: /src/core/constants.mts
 *	@Date: 2026-11-25T01:18:15-08:00 (1795598295)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T01:18:15-08:00 (1795598295)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * @fileoverview SQLite constants the core and the storage drivers use (values from sqlite3.h).
 */
/** Primary and extended result codes. */
export declare const SQLITE_OK = 0;
export declare const SQLITE_ERROR = 1;
export declare const SQLITE_BUSY = 5;
export declare const SQLITE_NOTFOUND = 12;
export declare const SQLITE_CANTOPEN = 14;
export declare const SQLITE_ROW = 100;
export declare const SQLITE_DONE = 101;
export declare const SQLITE_IOERR = 10;
export declare const SQLITE_IOERR_READ: number;
export declare const SQLITE_IOERR_SHORT_READ: number;
export declare const SQLITE_IOERR_WRITE: number;
export declare const SQLITE_IOERR_FSYNC: number;
export declare const SQLITE_IOERR_TRUNCATE: number;
export declare const SQLITE_IOERR_FSTAT: number;
export declare const SQLITE_IOERR_UNLOCK: number;
export declare const SQLITE_IOERR_LOCK: number;
export declare const SQLITE_IOERR_CLOSE: number;
export declare const SQLITE_IOERR_DELETE: number;
export declare const SQLITE_IOERR_ACCESS: number;
export declare const SQLITE_IOERR_CHECKRESERVEDLOCK: number;
export declare const SQLITE_IOERR_DELETE_NOENT: number;
/** sqlite3_open_v2() and xOpen flags. */
export declare const SQLITE_OPEN_READONLY = 1;
export declare const SQLITE_OPEN_READWRITE = 2;
export declare const SQLITE_OPEN_CREATE = 4;
export declare const SQLITE_OPEN_DELETEONCLOSE = 8;
export declare const SQLITE_OPEN_EXCLUSIVE = 16;
export declare const SQLITE_OPEN_URI = 64;
export declare const SQLITE_OPEN_MAIN_DB = 256;
export declare const SQLITE_OPEN_TEMP_DB = 512;
export declare const SQLITE_OPEN_MAIN_JOURNAL = 2048;
export declare const SQLITE_OPEN_WAL = 524288;
export declare const SQLITE_OPEN_EXRESCODE = 33554432;
/** Lock levels passed to xLock / xUnlock. */
export declare const SQLITE_LOCK_NONE = 0;
export declare const SQLITE_LOCK_SHARED = 1;
export declare const SQLITE_LOCK_RESERVED = 2;
export declare const SQLITE_LOCK_PENDING = 3;
export declare const SQLITE_LOCK_EXCLUSIVE = 4;
/** xAccess flags. */
export declare const SQLITE_ACCESS_EXISTS = 0;
export declare const SQLITE_ACCESS_READWRITE = 1;
export declare const SQLITE_ACCESS_READ = 2;
/** xDeviceCharacteristics bits. */
export declare const SQLITE_IOCAP_ATOMIC = 1;
export declare const SQLITE_IOCAP_SAFE_APPEND = 512;
export declare const SQLITE_IOCAP_SEQUENTIAL = 1024;
export declare const SQLITE_IOCAP_POWERSAFE_OVERWRITE = 4096;
/** Fundamental datatypes returned by sqlite3_column_type(). */
export declare const SQLITE_INTEGER = 1;
export declare const SQLITE_FLOAT = 2;
export declare const SQLITE_TEXT = 3;
export declare const SQLITE_BLOB = 4;
export declare const SQLITE_NULL = 5;
