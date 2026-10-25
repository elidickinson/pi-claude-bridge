// Consumer side of gentle-engram's local bridge ownership protocol. Native
// Engram answers on the Pi event bus (routing context, not authentication) when
// it has registered the exact Pi runtime session. "owned" means native Engram
// handles memory for that session; "unknown" and "no-reply" do not prove it is
// absent, so callers must keep Claude-side Engram in those cases.

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";

export type EngramOwnership = "owned" | "unknown" | "no-reply";

// Plugin ids of Claude Code's own Engram plugin.
export const ENGRAM_PLUGIN_IDS = ["engram@engram"];
// Tool-name prefixes of Engram's MCP tools as Claude Code exposes them.
export const ENGRAM_MCP_TOOL_PREFIXES = ["mcp__engram", "mcp__plugin_engram_engram"];

const CLAIM_CHANNEL = "engram:bridge:claim:v1";
const DECISION_CHANNEL = "engram:bridge:decision:v1";
const OPERATION = "session-register";
// The responder's own decision budget is 1000ms; leave headroom.
const DEFAULT_TIMEOUT_MS = 1500;

export function claimEngramSession(
	events: EventBus | undefined,
	runtimeSessionId: string | undefined,
	opts: { timeoutMs?: number } = {},
): Promise<EngramOwnership> {
	if (!events || typeof runtimeSessionId !== "string" || !runtimeSessionId.trim()) {
		return Promise.resolve("unknown");
	}
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const nonce = randomUUID();

	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let done = false;
		const finish = (result: EngramOwnership) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			try { unsubscribe?.(); } catch { /* best effort */ }
			resolve(result);
		};

		try {
			// Subscribe before emitting: emit does not await listeners and the
			// responder may reply synchronously.
			unsubscribe = events.on(DECISION_CHANNEL, (data: unknown) => {
				const r = data as Record<string, unknown> | null;
				if (!r || typeof r !== "object") return;
				if (r.runtimeSessionId !== runtimeSessionId || r.nonce !== nonce || r.operation !== OPERATION) return;
				if (r.status === "owned" || r.status === "unknown") finish(r.status);
			});
			timer = setTimeout(() => finish("no-reply"), timeoutMs);
			timer.unref?.();
			events.emit(CLAIM_CHANNEL, { runtimeSessionId, nonce, operation: OPERATION });
		} catch {
			finish("unknown");
		}
	});
}

export interface EngramOwnershipCache {
	get(events: EventBus | undefined, runtimeSessionId: string | undefined): Promise<EngramOwnership>;
	reset(): void;
}

/**
 * Per-session memo over claimEngramSession. "owned" and "no-reply" are cached
 * (no responder means every turn would otherwise wait out the timeout);
 * "unknown" is not, because registration may complete later.
 */
export function createEngramOwnershipCache(opts: { timeoutMs?: number } = {}): EngramOwnershipCache {
	const settled = new Map<string, EngramOwnership>();
	const inFlight = new Map<string, Promise<EngramOwnership>>();
	let generation = 0;

	return {
		get(events, runtimeSessionId) {
			if (typeof runtimeSessionId !== "string" || !runtimeSessionId.trim()) {
				return claimEngramSession(events, runtimeSessionId, opts);
			}
			const hit = settled.get(runtimeSessionId);
			if (hit) return Promise.resolve(hit);
			const pending = inFlight.get(runtimeSessionId);
			if (pending) return pending;

			const gen = generation;
			const p = claimEngramSession(events, runtimeSessionId, opts).then((result) => {
				// A reset() while in flight invalidates this result for caching.
				if (gen === generation) {
					inFlight.delete(runtimeSessionId);
					if (result !== "unknown") settled.set(runtimeSessionId, result);
				}
				return result;
			});
			inFlight.set(runtimeSessionId, p);
			return p;
		},
		reset() {
			generation++;
			settled.clear();
			inFlight.clear();
		},
	};
}
