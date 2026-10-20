// Per-child environment hook; the README section "Claude Code child environment"
// documents the protocol for listeners. The SDK's `options.env` replaces the
// Claude Code subprocess environment wholesale, so the bridge builds one detached
// record per query and lets extensions of the originating pi session adjust it,
// instead of anyone mutating process.env, which every concurrent session's child
// inherits. Each transform gets a fresh copy of the current record, so one that
// mutates its input and then throws changes nothing.
//
// The variables that locate Claude Code's session store (CHILD_ENV_STORAGE_KEYS)
// are pinned to the base environment: the bridge writes, reads and deletes the
// session files a child resumes through the parent's values, so a child that saw
// different ones would resume from a store the bridge never wrote. Each committed
// transform result and the final record get the base entries back exactly —
// absent stays absent, empty stays empty — and case variants are dropped, since
// Windows treats environment names case-insensitively. Diagnostics are fixed
// strings: thrown values are never inspected or coerced, because a listener's
// error can carry the credentials it was handling.
//
// The session → event bus registry lives on globalThis because the first module
// instance's streamSimple serves every session in the process (pi-subagents
// children, pi-web), while each session's own instance only sees its own
// session_start. Owners are compared on unbind so a stale instance's shutdown
// cannot remove the binding its replacement installed.
//
// The registry must not keep a session alive: AgentSession.dispose() does not
// emit session_shutdown, so an unbind is not guaranteed. The registry therefore
// holds each owner weakly, and the owner alone keeps its buses alive (an
// owner-keyed WeakMap). The caller keeps the owner reachable from the session's
// own handlers for as long as the session should be routed; once the session is
// unreachable, its owner and bus are collected and the dead entry is removed by
// the finalizer, or earlier by a lookup that finds it.

export const CHILD_ENV_CHANNEL = "claude-bridge:child-env";
export const CHILD_ENV_PROTOCOL_VERSION = 1;

export type ChildEnvPurpose = "provider" | "summary" | "askclaude";

export interface ChildEnvModel {
	/** Model id as pi registered it (no Claude Code `[1m]` suffix). */
	id: string;
	provider?: string;
	contextWindow?: number;
}

export type ChildEnvTransform = (env: Record<string, string>) => Record<string, string>;

export interface ChildEnvRequest {
	readonly version: typeof CHILD_ENV_PROTOCOL_VERSION;
	readonly purpose: ChildEnvPurpose;
	/** The pi session the child query serves. */
	readonly sessionId: string;
	readonly model: Readonly<ChildEnvModel>;
	register(transform: ChildEnvTransform): void;
}

interface ChildEnvBus {
	emit(channel: string, data: unknown): void;
}

interface Entry {
	owner: WeakRef<object>;
	/** Identifies this bind; also its finalizer unregister token. */
	token: object;
}

interface Registry {
	sessions: Map<string, Entry>;
	/** Each owner's bound buses by session id, alive exactly as long as the owner. */
	buses: WeakMap<object, Map<string, ChildEnvBus>>;
	/** Held values carry only the session id and token, never owner or bus. */
	finalizer: FinalizationRegistry<{ sessionId: string; token: object }>;
}

const REGISTRY_KEY = Symbol.for("claude-bridge:childEnvRegistry");

function registry(): Registry {
	const g = globalThis as Record<symbol, unknown>;
	return (g[REGISTRY_KEY] ??= newRegistry()) as Registry;
}

function newRegistry(): Registry {
	const sessions = new Map<string, Entry>();
	return {
		sessions,
		buses: new WeakMap(),
		finalizer: new FinalizationRegistry(({ sessionId, token }) => {
			if (sessions.get(sessionId)?.token === token) sessions.delete(sessionId);
		}),
	};
}

function drop(reg: Registry, sessionId: string, entry: Entry): void {
	reg.sessions.delete(sessionId);
	reg.finalizer.unregister(entry.token);
}

/**
 * Route child-env requests for `sessionId` to `events`. The latest bind wins.
 * The binding lasts while `owner` is reachable: the registry holds `owner`
 * weakly, so the caller must keep it alive (from the session's own handlers)
 * for as long as the session should be routed.
 */
export function bindChildEnvSession(sessionId: string, events: ChildEnvBus, owner: object): void {
	const reg = registry();
	let own = reg.buses.get(owner);
	if (!own) reg.buses.set(owner, (own = new Map()));
	own.set(sessionId, events);
	const current = reg.sessions.get(sessionId);
	if (current?.owner.deref() === owner) return;
	if (current) drop(reg, sessionId, current);
	const token = {};
	reg.sessions.set(sessionId, { owner: new WeakRef(owner), token });
	reg.finalizer.register(owner, { sessionId, token }, token);
}

/** Drop the binding for `sessionId` only if `owner` installed it. */
export function unbindChildEnvSession(sessionId: string, owner: object): void {
	const reg = registry();
	reg.buses.get(owner)?.delete(sessionId);
	const entry = reg.sessions.get(sessionId);
	if (entry?.owner.deref() === owner) drop(reg, sessionId, entry);
}

/** The bus bound to `sessionId`, pruning the entry if its owner was collected. */
function boundBus(sessionId: string): ChildEnvBus | undefined {
	const reg = registry();
	const entry = reg.sessions.get(sessionId);
	if (!entry) return undefined;
	const owner = entry.owner.deref();
	if (!owner) {
		drop(reg, sessionId, entry);
		return undefined;
	}
	return reg.buses.get(owner)?.get(sessionId);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (typeof (value as { then?: unknown }).then === "function") {
		// An async transform's result is never committed, but its rejection is
		// still observed so it cannot surface as an unhandledRejection.
		Promise.resolve(value).catch(() => {});
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value)) {
		if (typeof v !== "string") return undefined;
		out[key] = v;
	}
	return out;
}

/**
 * Claude Code's session store is CLAUDE_CONFIG_DIR, else homedir()/.claude, and
 * homedir() reads HOME (POSIX) or USERPROFILE (Windows). cc-session-io, which the
 * bridge syncs sessions through, resolves the same way from the parent's env.
 */
export const CHILD_ENV_STORAGE_KEYS: readonly string[] = Object.freeze(["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE"]);

const STORAGE_KEYS = new Set(CHILD_ENV_STORAGE_KEYS);
const isStorageKey = (key: string) => STORAGE_KEYS.has(key.toUpperCase());

type StorageEntries = ReadonlyArray<readonly [string, string]>;

function storageOf(env: Record<string, string>): StorageEntries {
	return Object.entries(env).filter(([key]) => isStorageKey(key));
}

/** `env` with every storage variable, in any case, replaced by `storage`. */
function withStorage(env: Record<string, string>, storage: StorageEntries): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(env)) if (!isStorageKey(key)) out[key] = v;
	for (const [key, v] of storage) out[key] = v;
	return out;
}

function sameStorage(env: Record<string, string>, storage: StorageEntries): boolean {
	const actual = storageOf(env);
	return actual.length === storage.length && storage.every(([key, v]) => Object.hasOwn(env, key) && env[key] === v);
}

/** The string entries of `env`, detached from it. */
function stringEntries(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(env)) if (typeof v === "string") out[key] = v;
	return out;
}

export interface ChildEnvTarget {
	purpose: ChildEnvPurpose;
	sessionId: string | null | undefined;
	model: ChildEnvModel;
}

/**
 * The environment for one Claude Code child: `base` plus `guards`, adjusted by
 * the originating session's registered transforms. `guards` are re-applied last,
 * so a transform can add or replace variables but cannot drop a bridge guard.
 * The storage variables are always exactly those of `base`, whatever the
 * transforms or `guards` say; `base` must be the environment the bridge's own
 * session-file access resolves from. Never logs environment contents or thrown
 * values — they carry credentials.
 */
export function buildChildEnv(
	base: NodeJS.ProcessEnv,
	guards: Readonly<Record<string, string>>,
	target: ChildEnvTarget,
	onError?: (message: string) => void,
): Record<string, string> {
	const parent = stringEntries(base);
	const storage = storageOf(parent);
	const pristine = withStorage({ ...parent, ...guards }, storage);
	const sessionId = target.sessionId;
	if (!sessionId) return pristine;
	const events = boundBus(sessionId);
	if (!events) return pristine;

	const transforms: ChildEnvTransform[] = [];
	let open = true;
	const request: ChildEnvRequest = Object.freeze({
		version: CHILD_ENV_PROTOCOL_VERSION,
		purpose: target.purpose,
		sessionId,
		model: Object.freeze({ ...target.model }),
		register(transform: ChildEnvTransform) {
			if (!open) throw new Error(`${CHILD_ENV_CHANNEL}: register() called after the request closed`);
			if (typeof transform !== "function") throw new TypeError(`${CHILD_ENV_CHANNEL}: register() expects a function`);
			transforms.push(transform);
		},
	});
	try {
		events.emit(CHILD_ENV_CHANNEL, request);
	} catch {
		// A stale runtime's bus throws on emit after reload/shutdown.
		onError?.("emit failed; using the base environment");
		return pristine;
	} finally {
		open = false;
	}

	let env = pristine;
	for (const [i, transform] of transforms.entries()) {
		let next: Record<string, string> | undefined;
		try {
			next = stringRecord(transform({ ...env }));
		} catch {
			onError?.(`transform ${i} threw; result ignored`);
			continue;
		}
		if (!next) {
			onError?.(`transform ${i} returned an invalid environment; ignored`);
			continue;
		}
		if (!sameStorage(next, storage)) onError?.(`transform ${i} changed Claude Code storage variables; restored the base values`);
		env = withStorage(next, storage);
	}
	return withStorage({ ...env, ...guards }, storage);
}
