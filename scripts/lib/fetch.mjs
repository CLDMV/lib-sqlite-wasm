/**
 *
 *	@Project: @cldmv/sqlite-wasm
 *	@Filename: scripts/lib/fetch.mjs
 *	@Date: 2026-11-25T01:04:03-08:00 (1795597443)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-25T13:30:11-08:00 (1795642211)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Shared download helper for the build and bump scripts: fetch with a timeout and retries.
 */

/** Download attempts and the first backoff delay; the delay doubles after each failed attempt (2 s, 4 s, 8 s, 16 s). */
const ATTEMPTS = 5;
const BACKOFF_MS = 2000;
/** One attempt is abandoned after this long, so a stalled connection cannot hang the build. */
const TIMEOUT_MS = 180_000;

/**
 * Fetches `url`, retrying network errors, timeouts, 429 and 5xx responses with exponential backoff. Other 4xx
 * responses fail at once (the pinned URL is wrong or gone; retrying cannot fix that).
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]  replaceable for tests
 * @param {(ms: number) => Promise<void>} [options.sleep]  replaceable for tests
 * @param {(message: string) => void} [options.log]
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<Buffer>}
 */
export async function fetchWithRetry(url, options = {}) {
	const { fetch: fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {}, headers } = options;
	let last = "";
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		log(`downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${ATTEMPTS})` : ""}`);
		try {
			const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...(headers && { headers }) });
			if (response.ok) return Buffer.from(await response.arrayBuffer());
			last = `HTTP ${response.status}`;
			if (response.status < 500 && response.status !== 429) break;
		} catch (error) {
			const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
			last = error instanceof Error ? `${error.message}${cause}` : String(error);
		}
		if (attempt < ATTEMPTS) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
	}
	throw new Error(`download failed: ${url}: ${last}`);
}
