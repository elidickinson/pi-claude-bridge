// Claude subscription usage meter.
//
// Two data sources, both keyed on the same underlying quota:
//   1. Active  — GET https://api.anthropic.com/api/oauth/usage with the Claude
//      Code OAuth token (the same endpoint Claude Code's own /usage screen and
//      `caut` query). Full breakdown (5-hour session, 7-day window, extra
//      usage). Used on startup, on a timer, and for the /claude-usage command.
//   2. Passive — the bridge already receives `rate_limit_event` SDK messages
//      ({ status, rateLimitType, utilization, resetsAt }) during every query.
//      Feeding those in keeps the footer meter fresh for free while you work,
//      with no extra network call.
//
// `utilization` is percent USED (e.g. 13 => 13% used); "how much is left" is
// therefore 100 - utilization.

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const AUTH_FAILURE_BACKOFF_MS = 5 * 60_000;

let usageFetchBackoffUntil = 0;

/** A single quota window as shown in the meter. */
export interface UsageWindow {
	/** Stable key matching the API field / rate_limit_event type (e.g. "five_hour"). */
	key: string;
	/** Short human label for the footer/panel (e.g. "5h", "7d"). */
	label: string;
	/** Percent used, 0-100. */
	utilization: number;
	/** Percent remaining, 0-100. */
	remaining: number;
	/** When this window resets, if known. */
	resetsAt?: Date;
}

export interface UsageSnapshot {
	windows: UsageWindow[];
	/** Extra-usage (metered overage) summary line, when enabled. */
	extraUsage?: string;
	fetchedAt: Date;
}

/** rate_limit_event payload the bridge already receives from the Agent SDK. */
export interface RateLimitInfo {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: string | number;
}

// Windows we surface, in display order. Anything else in the response is ignored.
const WINDOW_LABELS: Record<string, string> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_opus: "7d Opus",
	seven_day_sonnet: "7d Sonnet",
};

function clampPct(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, n));
}

function parseResetsAt(v: unknown): Date | undefined {
	if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000);
	if (typeof v === "string") {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? undefined : d;
	}
	return undefined;
}

/** Human "resets in Xh Ym" / "resets in Nd" from now. */
export function formatReset(resetsAt: Date | undefined, now = new Date()): string {
	if (!resetsAt) return "";
	let secs = Math.round((resetsAt.getTime() - now.getTime()) / 1000);
	if (secs <= 0) return "resetting";
	const d = Math.floor(secs / 86400);
	secs -= d * 86400;
	const h = Math.floor(secs / 3600);
	secs -= h * 3600;
	const m = Math.floor(secs / 60);
	if (d > 0) return `resets in ${d}d ${h}h`;
	if (h > 0) return `resets in ${h}h ${m}m`;
	return `resets in ${m}m`;
}

/**
 * Read the Claude Code OAuth access token.
 *
 * macOS: the token lives in the login Keychain under the generic-password
 * service "Claude Code-credentials". Elsewhere Claude Code writes
 * ~/.claude/.credentials.json. Both hold the same JSON shape:
 * `{ "claudeAiOauth": { "accessToken": "...", ... } }`.
 */
export async function getOAuthToken(): Promise<string | null> {
	// macOS Keychain first.
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("security", [
				"find-generic-password",
				"-w",
				"-s",
				KEYCHAIN_SERVICE,
			]);
			const tok = extractAccessToken(stdout);
			if (tok) return tok;
		} catch {
			// Fall through to the file-based credential store.
		}
	}
	const credPath = join(homedir(), ".claude", ".credentials.json");
	if (existsSync(credPath)) {
		try {
			return extractAccessToken(readFileSync(credPath, "utf-8"));
		} catch {
			return null;
		}
	}
	return null;
}

function extractAccessToken(raw: string): string | null {
	try {
		const json = JSON.parse(raw.trim());
		const tok = json?.claudeAiOauth?.accessToken;
		return typeof tok === "string" && tok.length > 0 ? tok : null;
	} catch {
		return null;
	}
}

interface RawWindow {
	utilization?: number | null;
	resets_at?: string | null;
}

function toWindow(key: string, raw: RawWindow | null | undefined): UsageWindow | null {
	if (!raw || typeof raw.utilization !== "number") return null;
	const utilization = clampPct(raw.utilization);
	return {
		key,
		label: WINDOW_LABELS[key] ?? key,
		utilization,
		remaining: clampPct(100 - utilization),
		resetsAt: parseResetsAt(raw.resets_at),
	};
}

/** Fetch and normalise the live usage snapshot. Returns null on any failure. */
export async function fetchUsage(options: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
	if (!options.force && Date.now() < usageFetchBackoffUntil) return null;
	const token = await getOAuthToken();
	if (!token) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let data: Record<string, unknown>;
	try {
		const res = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": OAUTH_BETA_HEADER,
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			if (res.status === 429) usageFetchBackoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
			else if (res.status === 401 || res.status === 403) usageFetchBackoffUntil = Date.now() + AUTH_FAILURE_BACKOFF_MS;
			return null;
		}
		usageFetchBackoffUntil = 0;
		data = (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	const windows: UsageWindow[] = [];
	for (const key of Object.keys(WINDOW_LABELS)) {
		const w = toWindow(key, data[key] as RawWindow | null | undefined);
		if (w) windows.push(w);
	}
	if (windows.length === 0) return null;

	let extraUsage: string | undefined;
	const eu = data.extra_usage as { is_enabled?: boolean; utilization?: number } | undefined;
	if (eu?.is_enabled) {
		extraUsage = `extra usage ${Math.round(clampPct(eu.utilization ?? 0))}% used`;
	}

	return { windows, extraUsage, fetchedAt: new Date() };
}

/**
 * Overlay a passive rate_limit_event onto an existing snapshot, returning an
 * updated copy. If the event's window isn't already tracked it is appended.
 */
export function applyRateLimitInfo(
	snapshot: UsageSnapshot | null,
	info: RateLimitInfo,
): UsageSnapshot | null {
	if (typeof info.utilization !== "number" || !info.rateLimitType) return snapshot;
	const key = info.rateLimitType;
	const utilization = clampPct(info.utilization);
	const next: UsageWindow = {
		key,
		label: WINDOW_LABELS[key] ?? key,
		utilization,
		remaining: clampPct(100 - utilization),
		resetsAt: parseResetsAt(info.resetsAt),
	};
	const windows = snapshot ? [...snapshot.windows] : [];
	const idx = windows.findIndex((w) => w.key === key);
	if (idx >= 0) windows[idx] = { ...next, resetsAt: next.resetsAt ?? windows[idx].resetsAt };
	else windows.push(next);
	return { windows, extraUsage: snapshot?.extraUsage, fetchedAt: new Date() };
}

/** Local clock time HH:MM (for the 5-hour reset). */
export function formatResetClock(date: Date | undefined): string {
	if (!date) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local short weekday, e.g. "Sat" (for the 7-day reset). */
export function formatResetDay(date: Date | undefined): string {
	if (!date) return "";
	return WEEKDAYS[date.getDay()];
}

/**
 * Compact one-line footer, percent USED, with a reset hint per window:
 * the 5-hour window shows its reset clock time, the 7-day window its reset day.
 * e.g. "Claude 5h 19% (Res. 12:50) · 7d 21% (Res. Sat)".
 */
export function formatStatus(snapshot: UsageSnapshot): string {
	const parts = snapshot.windows
		.filter((w) => w.key === "five_hour" || w.key === "seven_day")
		.map((w) => {
			const reset = w.key === "five_hour" ? formatResetClock(w.resetsAt) : formatResetDay(w.resetsAt);
			const rseg = reset ? ` (Res. ${reset})` : "";
			return `${w.label} ${Math.round(w.utilization)}%${rseg}`;
		});
	if (parts.length === 0) return "";
	return `Claude ${parts.join(" · ")}`;
}

/** Multi-line panel for the /claude-usage command. */
export function formatPanel(snapshot: UsageSnapshot, now = new Date()): string {
	const lines: string[] = ["Claude subscription usage (remaining):"];
	for (const w of snapshot.windows) {
		const reset = formatReset(w.resetsAt, now);
		const used = `${Math.round(w.utilization)}% used`;
		const tail = reset ? `${used}, ${reset}` : used;
		lines.push(`  ${w.label.padEnd(10)} ${String(Math.round(w.remaining)).padStart(3)}% left   (${tail})`);
	}
	if (snapshot.extraUsage) lines.push(`  ${snapshot.extraUsage}`);
	return lines.join("\n");
}
