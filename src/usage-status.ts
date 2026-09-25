// Subscription usage status: Claude Code's rate-limit windows, surfaced in pi's footer.
//
// Claude Code emits a `rate_limit_event` with every request. Beyond the documented
// SDKRateLimitInfo fields it carries `unifiedWindows`, the utilization and reset time of
// every plan window at once (observed shape, recorded in tests/fixtures/sdk-streams):
//
//   unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1790350200 },
//                     seven_day: { utilization: 0.15, resetsAt: 1790643600 } }
//
// utilization is a fraction (0..1) and resetsAt is Unix seconds. The latest snapshot is
// kept on disk so a new session shows the last known state before its first request.
//
// Extracted from index.ts so tests can import it without activating the extension.

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";

export interface UsageWindow {
	/** Fraction of the window used, 0..1. */
	utilization: number;
	/** Unix seconds. */
	resetsAt?: number;
}

export interface UsageSnapshot {
	/** Epoch milliseconds of the rate_limit_event this came from. */
	observedAt: number;
	windows: Record<string, UsageWindow>;
	overageStatus?: string;
	overageDisabledReason?: string;
}

const WINDOW_LABELS: Record<string, string> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_opus: "7d Opus",
	seven_day_sonnet: "7d Sonnet",
};
const WINDOW_ORDER = Object.keys(WINDOW_LABELS);

function toWindow(value: unknown): UsageWindow | null {
	const v = value as { utilization?: unknown; resetsAt?: unknown } | null;
	if (!v || typeof v.utilization !== "number" || !Number.isFinite(v.utilization)) return null;
	return {
		utilization: v.utilization,
		...(typeof v.resetsAt === "number" && Number.isFinite(v.resetsAt) ? { resetsAt: v.resetsAt } : {}),
	};
}

/** The windows a rate_limit_info reports, or null when it reports none (older CLIs send
 *  only status/resetsAt on an "allowed" event). Without `unifiedWindows`, falls back to
 *  the single window named by `rateLimitType`. */
export function snapshotFromRateLimitInfo(info: any, now: number): UsageSnapshot | null {
	if (!info || typeof info !== "object") return null;
	const windows: Record<string, UsageWindow> = {};
	if (info.unifiedWindows && typeof info.unifiedWindows === "object") {
		for (const [name, value] of Object.entries(info.unifiedWindows)) {
			const w = toWindow(value);
			if (w) windows[name] = w;
		}
	} else if (typeof info.rateLimitType === "string") {
		const w = toWindow(info);
		if (w) windows[info.rateLimitType] = w;
	}
	if (Object.keys(windows).length === 0) return null;
	return {
		observedAt: now,
		windows,
		...(typeof info.overageStatus === "string" ? { overageStatus: info.overageStatus } : {}),
		...(typeof info.overageDisabledReason === "string" ? { overageDisabledReason: info.overageDisabledReason } : {}),
	};
}

/** Newer windows replace older ones by name; a window the newer event omits is kept. */
export function mergeUsageSnapshot(prev: UsageSnapshot | null, next: UsageSnapshot): UsageSnapshot {
	if (!prev) return next;
	return {
		...next,
		windows: { ...prev.windows, ...next.windows },
		overageStatus: next.overageStatus ?? prev.overageStatus,
		overageDisabledReason: next.overageStatus ? next.overageDisabledReason : prev.overageDisabledReason,
	};
}

function orderedWindows(snapshot: UsageSnapshot): Array<[string, UsageWindow]> {
	const rank = (name: string) => {
		const i = WINDOW_ORDER.indexOf(name);
		return i === -1 ? WINDOW_ORDER.length : i;
	};
	return Object.entries(snapshot.windows).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

function isExpired(w: UsageWindow, now: number): boolean {
	return w.resetsAt !== undefined && w.resetsAt * 1000 <= now;
}

function label(name: string): string {
	return WINDOW_LABELS[name] ?? name;
}

function percent(w: UsageWindow): string {
	return `${Math.round(w.utilization * 100)}%`;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Clock time for a reset within a day, otherwise month/day. Local time. */
function shortReset(resetsAt: number, now: number): string {
	const d = new Date(resetsAt * 1000);
	if (resetsAt * 1000 - now < 24 * 3600 * 1000) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fullTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function duration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One-line footer status, e.g. "Claude 5h 8% ↻18:30 · 7d 15% ↻9/30". Windows whose reset
 *  time has passed are left out, since their utilization no longer applies; undefined when
 *  none remain. */
export function formatUsageStatus(snapshot: UsageSnapshot | null, now: number): string | undefined {
	if (!snapshot) return undefined;
	const parts = orderedWindows(snapshot)
		.filter(([, w]) => !isExpired(w, now))
		.map(([name, w]) => `${label(name)} ${percent(w)}${w.resetsAt !== undefined ? ` ↻${shortReset(w.resetsAt, now)}` : ""}`);
	return parts.length ? `Claude ${parts.join(" · ")}` : undefined;
}

/** Multi-line detail for /claude-usage. */
export function formatUsageDetails(snapshot: UsageSnapshot | null, now: number): string {
	if (!snapshot) return "Claude usage: nothing reported yet. Claude Code reports it with every claude-bridge request.";
	const lines = [`Claude usage (reported ${fullTime(snapshot.observedAt)}, ${duration(now - snapshot.observedAt)} ago)`];
	for (const [name, w] of orderedWindows(snapshot)) {
		let reset = "";
		if (w.resetsAt !== undefined) {
			const at = w.resetsAt * 1000;
			reset = isExpired(w, now)
				? ` — reset at ${fullTime(at)}; current usage unknown until the next request`
				: ` — resets ${fullTime(at)} (in ${duration(at - now)})`;
		}
		lines.push(`  ${label(name)}: ${percent(w)}${reset}`);
	}
	if (snapshot.overageStatus) {
		const reason = snapshot.overageDisabledReason ? ` (${snapshot.overageDisabledReason})` : "";
		lines.push(`  Extra usage: ${snapshot.overageStatus}${reason}`);
	}
	return lines.join("\n");
}

/** The saved snapshot, or null when the file is missing or not a snapshot. */
export function loadUsageSnapshot(path: string): UsageSnapshot | null {
	if (!existsSync(path)) return null;
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw.observedAt !== "number" || !raw.windows || typeof raw.windows !== "object") return null;
	const windows: Record<string, UsageWindow> = {};
	for (const [name, value] of Object.entries(raw.windows)) {
		const w = toWindow(value);
		if (w) windows[name] = w;
	}
	return {
		observedAt: raw.observedAt,
		windows,
		...(typeof raw.overageStatus === "string" ? { overageStatus: raw.overageStatus } : {}),
		...(typeof raw.overageDisabledReason === "string" ? { overageDisabledReason: raw.overageDisabledReason } : {}),
	};
}

/** Write through a temp file so a concurrent reader never sees a partial snapshot. */
export function saveUsageSnapshot(path: string, snapshot: UsageSnapshot): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(snapshot) + "\n");
	renameSync(tmp, path);
}

/** Whether `next` differs from `saved` in anything the status shows. */
export function usageChanged(saved: UsageSnapshot | null, next: UsageSnapshot): boolean {
	if (!saved) return true;
	const key = (s: UsageSnapshot) => JSON.stringify([
		orderedWindows(s).map(([name, w]) => [name, Math.round(w.utilization * 100), w.resetsAt ?? null]),
		s.overageStatus ?? null,
		s.overageDisabledReason ?? null,
	]);
	return key(saved) !== key(next);
}
