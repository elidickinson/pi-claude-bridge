// Publishes the subscription rate-limit windows Claude Code already streams
// (`rate_limit_event`) on a process-wide, provider-neutral bus so that other
// extensions (quota dashboards, status bars) can render them. The bridge itself
// renders nothing: it only records the latest sample per window and publishes.
//
// The bus lives at `globalThis[Symbol.for("pi.provider-usage.bus.v1")]` and is
// created here only when no other extension has already put one there, so
// several publishers and consumers share a single instance regardless of load
// order. Consumers never import this package; they resolve the symbol and
// validate the shapes below.

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export const PROVIDER_USAGE_BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");

/** Id of the adapter this bridge registers; also stamped on every snapshot. */
export const CLAUDE_BRIDGE_ADAPTER_ID = "claude-bridge";
/** The usage provider (the subscription being metered), shared by any Claude bridge. */
export const CLAUDE_USAGE_PROVIDER = "claude";
/** pi model provider ids whose traffic this adapter meters. */
export const CLAUDE_BRIDGE_MODEL_PROVIDERS = ["claude-bridge"] as const;

export interface UsageWindow {
	/** Claude Code's window name: five_hour, seven_day, seven_day_opus, ... */
	id: string;
	/** 0..100 (Claude Code reports utilization as a 0..1 fraction). */
	usedPercent: number;
	/** Rolling window length, in minutes. */
	windowMinutes: number;
	/** Unix seconds when the window resets, or null when Claude Code sent none. */
	resetsAt: number | null;
	/** Claude Code's status for the sample this window was last seen in. */
	state: SDKRateLimitInfo["status"];
	/** Set on model-family windows (seven_day_opus → Opus) so consumers can label them. */
	scope?: { kind: "model"; label: string };
	/** Epoch ms when this window was last sampled. */
	capturedAt: number;
}

export interface UsageSnapshot {
	version: 1;
	provider: typeof CLAUDE_USAGE_PROVIDER;
	adapterId: string;
	/** Epoch ms of the sample that produced this snapshot. */
	capturedAt: number;
	windows: UsageWindow[];
	/** True when Claude Code reports Extra Usage credits are being consumed. */
	overageInUse: boolean;
}

export interface UsageAdapter {
	id: string;
	usageProvider: string;
	modelProviders: readonly string[];
	/** Resolves from local state: no network call is made. */
	refresh(options?: { timeoutMs?: number }): Promise<UsageSnapshot | undefined>;
}

export interface UsageEvent {
	adapterId: string;
	snapshot: UsageSnapshot;
}

export interface ProviderUsageBus {
	version: 1;
	register(adapter: UsageAdapter): () => void;
	adapters(): UsageAdapter[];
	subscribe(listener: (event: UsageEvent) => void): () => void;
	publish(event: UsageEvent): void;
}

const FIVE_HOURS_MINUTES = 5 * 60;
const SEVEN_DAYS_MINUTES = 7 * 24 * 60;
// "overage" is a status flag Claude Code sends alongside the windows, not a quota
// window itself, so it is folded into `overageInUse` instead of becoming a row.
const OVERAGE_WINDOW = "overage";

function isBus(value: unknown): value is ProviderUsageBus {
	if (!value || typeof value !== "object") return false;
	const bus = value as Record<string, unknown>;
	return (
		typeof bus.register === "function" &&
		typeof bus.adapters === "function" &&
		typeof bus.subscribe === "function" &&
		typeof bus.publish === "function"
	);
}

function createBus(): ProviderUsageBus {
	const adapters = new Map<string, UsageAdapter>();
	const listeners = new Set<(event: UsageEvent) => void>();
	return {
		version: 1,
		register(adapter) {
			// Re-registration under the same id replaces the previous entry, so a
			// /reload (a fresh module instance registering again) never accumulates.
			adapters.set(adapter.id, adapter);
			return () => {
				if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id);
			};
		},
		adapters() {
			return [...adapters.values()];
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publish(event) {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch {
					// A consumer's failure is its own; it must not break the publisher
					// or starve the other listeners.
				}
			}
		},
	};
}

/** Returns the shared bus, creating it only when no other extension already has. */
export function getProviderUsageBus(globalObject: object = globalThis): ProviderUsageBus {
	const g = globalObject as Record<symbol, unknown>;
	const existing = g[PROVIDER_USAGE_BUS_SYMBOL];
	if (isBus(existing)) return existing;
	const bus = createBus();
	g[PROVIDER_USAGE_BUS_SYMBOL] = bus;
	return bus;
}

export function windowMinutesFor(id: string): number | undefined {
	if (id === "five_hour") return FIVE_HOURS_MINUTES;
	if (id.startsWith("seven_day")) return SEVEN_DAYS_MINUTES;
	return undefined;
}

export function windowScopeFor(id: string): UsageWindow["scope"] | undefined {
	const family = /^seven_day_(opus|sonnet|haiku)$/.exec(id)?.[1];
	if (!family) return undefined;
	return { kind: "model", label: family.charAt(0).toUpperCase() + family.slice(1) };
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildWindow(id: string, utilization: number | undefined, resetsAt: number | undefined, state: SDKRateLimitInfo["status"], now: number): UsageWindow | undefined {
	if (id === OVERAGE_WINDOW) return undefined;
	const windowMinutes = windowMinutesFor(id);
	if (windowMinutes === undefined) return undefined;
	const usedPercent = Math.max(0, Math.min(100, (utilization ?? 0) * 100));
	const scope = windowScopeFor(id);
	return {
		id,
		usedPercent,
		windowMinutes,
		resetsAt: resetsAt !== undefined && resetsAt > 0 ? resetsAt : null,
		state,
		...(scope ? { scope } : {}),
		capturedAt: now,
	};
}

/**
 * Turns one `rate_limit_info` into the windows it describes. Current Claude
 * Code builds carry every window in `unifiedWindows` (`{ five_hour: {
 * utilization, resetsAt }, seven_day: {...} }`), with the top-level
 * `rateLimitType`/`status` naming the window the status applies to; that field
 * is not in the SDK's declared type yet, so it is read structurally. Older
 * builds sent one window per event as top-level `rateLimitType`/`utilization`,
 * which stays the fallback. Window types this module cannot size are skipped
 * rather than published with a made-up length.
 */
export function windowsFromRateLimitInfo(info: SDKRateLimitInfo, now: number): UsageWindow[] {
	const flagged = typeof info?.rateLimitType === "string" ? info.rateLimitType : undefined;
	const unified = (info as { unifiedWindows?: unknown })?.unifiedWindows;
	if (unified && typeof unified === "object" && !Array.isArray(unified)) {
		const windows: UsageWindow[] = [];
		for (const [id, raw] of Object.entries(unified as Record<string, unknown>)) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as { utilization?: unknown; resetsAt?: unknown };
			const utilization = finiteNumber(entry.utilization);
			if (utilization === undefined) continue;
			const state = id === flagged ? info.status : "allowed";
			const window = buildWindow(id, utilization, finiteNumber(entry.resetsAt) ?? (id === flagged ? finiteNumber(info.resetsAt) : undefined), state, now);
			if (window) windows.push(window);
		}
		if (windows.length > 0) return windows;
	}
	if (flagged === undefined) return [];
	const window = buildWindow(flagged, finiteNumber(info.utilization), finiteNumber(info.resetsAt), info.status, now);
	return window ? [window] : [];
}

export interface ClaudeUsageTracker {
	/** Records one rate_limit_event sample and publishes the updated snapshot. */
	record(info: SDKRateLimitInfo, now?: number): void;
	/** The latest snapshot, or undefined before the first sample. */
	snapshot(): UsageSnapshot | undefined;
	adapter: UsageAdapter;
}

/**
 * Keeps the latest sample per window (each event carries a single window, so
 * the picture fills in over successive turns) and publishes a full snapshot on
 * every sample. Windows the account never reports are simply absent.
 */
export function createClaudeUsageTracker(bus: ProviderUsageBus, clock: () => number = Date.now): ClaudeUsageTracker {
	const windows = new Map<string, UsageWindow>();
	let latest: UsageSnapshot | undefined;

	const adapter: UsageAdapter = {
		id: CLAUDE_BRIDGE_ADAPTER_ID,
		usageProvider: CLAUDE_USAGE_PROVIDER,
		modelProviders: CLAUDE_BRIDGE_MODEL_PROVIDERS,
		refresh: async () => latest,
	};

	return {
		adapter,
		snapshot: () => latest,
		record(info, now = clock()) {
			if (!info || typeof info !== "object") return;
			const sampled = windowsFromRateLimitInfo(info, now);
			for (const window of sampled) windows.set(window.id, window);
			const overageInUse = info.isUsingOverage === true || info.overageInUse === true;
			// Nothing renderable yet: no window and no overage signal.
			if (windows.size === 0 && !overageInUse && !latest) return;
			// A sample that changed nothing (unknown window, same flags) is not a new snapshot.
			if (sampled.length === 0 && latest && latest.overageInUse === overageInUse) return;
			latest = {
				version: 1,
				provider: CLAUDE_USAGE_PROVIDER,
				adapterId: adapter.id,
				capturedAt: now,
				windows: [...windows.values()],
				overageInUse,
			};
			bus.publish({ adapterId: adapter.id, snapshot: latest });
		},
	};
}
