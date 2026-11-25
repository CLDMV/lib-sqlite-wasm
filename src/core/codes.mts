/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: src/core/codes.mts
 *	@Date: 2026-11-25T01:43:39-08:00 (1795599819)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:12-08:00 (1795642212)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Names for SQLite result codes ("SQLITE_CONSTRAINT_UNIQUE" for 2067), from sqlite3.h.
 *
 * SQLite has no API that returns a code's name (sqlite3_errstr() gives the English message), so the table is kept
 * here. An extended code missing from it falls back to its primary code's name.
 */

/** Primary result codes by number. */
const PRIMARY: Record<number, string> = {
	0: "OK",
	1: "ERROR",
	2: "INTERNAL",
	3: "PERM",
	4: "ABORT",
	5: "BUSY",
	6: "LOCKED",
	7: "NOMEM",
	8: "READONLY",
	9: "INTERRUPT",
	10: "IOERR",
	11: "CORRUPT",
	12: "NOTFOUND",
	13: "FULL",
	14: "CANTOPEN",
	15: "PROTOCOL",
	16: "EMPTY",
	17: "SCHEMA",
	18: "TOOBIG",
	19: "CONSTRAINT",
	20: "MISMATCH",
	21: "MISUSE",
	22: "NOLFS",
	23: "AUTH",
	24: "FORMAT",
	25: "RANGE",
	26: "NOTADB",
	27: "NOTICE",
	28: "WARNING",
	100: "ROW",
	101: "DONE"
};

/** Extended result codes: primary name -> names of (code >> 8) = 1, 2, 3, ... */
const EXTENDED: Record<string, string[]> = {
	OK: ["LOAD_PERMANENTLY", "SYMLINK"],
	ERROR: ["MISSING_COLLSEQ", "RETRY", "SNAPSHOT", "RESERVESIZE", "KEY", "UNABLE"],
	IOERR: [
		"READ",
		"SHORT_READ",
		"WRITE",
		"FSYNC",
		"DIR_FSYNC",
		"TRUNCATE",
		"FSTAT",
		"UNLOCK",
		"RDLOCK",
		"DELETE",
		"BLOCKED",
		"NOMEM",
		"ACCESS",
		"CHECKRESERVEDLOCK",
		"LOCK",
		"CLOSE",
		"DIR_CLOSE",
		"SHMOPEN",
		"SHMSIZE",
		"SHMLOCK",
		"SHMMAP",
		"SEEK",
		"DELETE_NOENT",
		"MMAP",
		"GETTEMPPATH",
		"CONVPATH",
		"VNODE",
		"AUTH",
		"BEGIN_ATOMIC",
		"COMMIT_ATOMIC",
		"ROLLBACK_ATOMIC",
		"DATA",
		"CORRUPTFS",
		"IN_PAGE",
		"BADKEY",
		"CODEC"
	],
	LOCKED: ["SHAREDCACHE", "VTAB"],
	BUSY: ["RECOVERY", "SNAPSHOT", "TIMEOUT"],
	CANTOPEN: ["NOTEMPDIR", "ISDIR", "FULLPATH", "CONVPATH", "DIRTYWAL", "SYMLINK"],
	CORRUPT: ["VTAB", "SEQUENCE", "INDEX"],
	READONLY: ["RECOVERY", "CANTLOCK", "ROLLBACK", "DBMOVED", "CANTINIT", "DIRECTORY"],
	ABORT: ["", "ROLLBACK"],
	CONSTRAINT: [
		"CHECK",
		"COMMITHOOK",
		"FOREIGNKEY",
		"FUNCTION",
		"NOTNULL",
		"PRIMARYKEY",
		"TRIGGER",
		"UNIQUE",
		"VTAB",
		"ROWID",
		"PINNED",
		"DATATYPE"
	],
	NOTICE: ["RECOVER_WAL", "RECOVER_ROLLBACK", "RBU"],
	WARNING: ["AUTOINDEX"],
	AUTH: ["USER"]
};

/** The `SQLITE_*` name of result code `code`, e.g. "SQLITE_CONSTRAINT_UNIQUE". */
export function codeName(code: number): string {
	const primary = PRIMARY[code & 0xff] ?? "UNKNOWN";
	const extended = EXTENDED[primary]?.[(code >> 8) - 1];
	return extended ? `SQLITE_${primary}_${extended}` : `SQLITE_${primary}`;
}
