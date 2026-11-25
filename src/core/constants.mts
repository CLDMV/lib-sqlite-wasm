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
export const SQLITE_OK = 0;
export const SQLITE_ERROR = 1;
export const SQLITE_BUSY = 5;
export const SQLITE_NOTFOUND = 12;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_ROW = 100;
export const SQLITE_DONE = 101;
export const SQLITE_IOERR = 10;
export const SQLITE_IOERR_READ = SQLITE_IOERR | (1 << 8);
export const SQLITE_IOERR_SHORT_READ = SQLITE_IOERR | (2 << 8);
export const SQLITE_IOERR_WRITE = SQLITE_IOERR | (3 << 8);
export const SQLITE_IOERR_FSYNC = SQLITE_IOERR | (4 << 8);
export const SQLITE_IOERR_TRUNCATE = SQLITE_IOERR | (6 << 8);
export const SQLITE_IOERR_FSTAT = SQLITE_IOERR | (7 << 8);
export const SQLITE_IOERR_UNLOCK = SQLITE_IOERR | (8 << 8);
export const SQLITE_IOERR_LOCK = SQLITE_IOERR | (15 << 8);
export const SQLITE_IOERR_CLOSE = SQLITE_IOERR | (16 << 8);
export const SQLITE_IOERR_DELETE = SQLITE_IOERR | (10 << 8);
export const SQLITE_IOERR_ACCESS = SQLITE_IOERR | (13 << 8);
export const SQLITE_IOERR_CHECKRESERVEDLOCK = SQLITE_IOERR | (14 << 8);
export const SQLITE_IOERR_DELETE_NOENT = SQLITE_IOERR | (23 << 8);

/** sqlite3_open_v2() and xOpen flags. */
export const SQLITE_OPEN_READONLY = 0x00000001;
export const SQLITE_OPEN_READWRITE = 0x00000002;
export const SQLITE_OPEN_CREATE = 0x00000004;
export const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
export const SQLITE_OPEN_EXCLUSIVE = 0x00000010;
export const SQLITE_OPEN_URI = 0x00000040;
export const SQLITE_OPEN_MAIN_DB = 0x00000100;
export const SQLITE_OPEN_TEMP_DB = 0x00000200;
export const SQLITE_OPEN_MAIN_JOURNAL = 0x00000800;
export const SQLITE_OPEN_WAL = 0x00080000;
export const SQLITE_OPEN_EXRESCODE = 0x02000000;

/** Lock levels passed to xLock / xUnlock. */
export const SQLITE_LOCK_NONE = 0;
export const SQLITE_LOCK_SHARED = 1;
export const SQLITE_LOCK_RESERVED = 2;
export const SQLITE_LOCK_PENDING = 3;
export const SQLITE_LOCK_EXCLUSIVE = 4;

/** xAccess flags. */
export const SQLITE_ACCESS_EXISTS = 0;
export const SQLITE_ACCESS_READWRITE = 1;
export const SQLITE_ACCESS_READ = 2;

/** xDeviceCharacteristics bits. */
export const SQLITE_IOCAP_ATOMIC = 0x00000001;
export const SQLITE_IOCAP_SAFE_APPEND = 0x00000200;
export const SQLITE_IOCAP_SEQUENTIAL = 0x00000400;
export const SQLITE_IOCAP_POWERSAFE_OVERWRITE = 0x00001000;

/** Fundamental datatypes returned by sqlite3_column_type(). */
export const SQLITE_INTEGER = 1;
export const SQLITE_FLOAT = 2;
export const SQLITE_TEXT = 3;
export const SQLITE_BLOB = 4;
export const SQLITE_NULL = 5;
