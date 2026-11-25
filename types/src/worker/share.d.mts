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
import { type endpoint, type request } from "./protocol.mts";
/** The parts of a LockManager sharing uses. */
export interface locks {
    request(name: string, options: {
        signal?: AbortSignal;
    }, callback: (lock: unknown) => unknown): Promise<unknown>;
}
/** The parts of a BroadcastChannel sharing uses. */
export interface broadcast {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    close(): void;
}
/** A started worker. */
export interface worker extends endpoint {
    terminate(): void;
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
/** Whether running `request` twice is harmless. */
export declare function reads(request: request): boolean;
/**
 * The page's Web Locks, BroadcastChannel, Worker and crypto, read once when a shared connection starts.
 * @param target  the worker script, started again by each tab that becomes the leader
 */
export declare function ambient(target: string | URL): environment;
/** The stand-in for the worker in a shared connection. */
export declare class coordinator {
    #private;
    constructor(target: unknown, env: environment);
    /** Whether this tab is the leader. */
    get leader(): boolean;
    /** Calls `listener` when this tab becomes, or stops being, the leader; returns the function that stops it. */
    readonly watch: (listener: watcher) => (() => void);
    addEventListener(type: string, listener: (event: never) => void): void;
    removeEventListener(type: string, listener: (event: never) => void): void;
    /** A request from the client's link. */
    postMessage(message: unknown): void;
}
