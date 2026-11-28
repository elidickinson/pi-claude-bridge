// Claude Code reports plan usage as SDK rate_limit_event messages, not HTTP
// headers. Rebuilding the unified headers it can supply lets pi's
// after_provider_response consumers read the bridge like the built-in provider.

import type { ProviderResponse } from "@earendil-works/pi-ai";

const HEADER_PREFIX = "anthropic-ratelimit-unified";
const HTTP_OK = 200;

/** Claude Code's own window-name → header-abbreviation table. */
const WINDOW_ABBREVIATIONS: Readonly<Record<string, string>> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_overage_included: "7d_oi",
	overage: "overage",
};

type UsageWindow = { utilization?: number; resetsAt?: number };

export type RateLimitInfo = {
	status?: string;
	resetsAt?: number;
	rateLimitType?: string;
	utilization?: number;
	overageStatus?: string;
	overageResetsAt?: number;
	unifiedWindows?: Record<string, UsageWindow | undefined>;
};

/** Always 200: a "rejected" status can still be served from overage, so only the status header says so. */
export function rateLimitResponse(info: RateLimitInfo): ProviderResponse {
	const headers: Record<string, string> = {};
	const set = (name: string, value: string | number | undefined) => {
		if (value !== undefined) headers[`${HEADER_PREFIX}-${name}`] = String(value);
	};

	set("status", info.status);
	set("reset", info.resetsAt);
	set("representative-claim", info.rateLimitType);
	set("overage-status", info.overageStatus);

	// unifiedWindows never includes overage, and a warning Claude Code keeps after
	// losing the window readings arrives without it; the event's own window fills in.
	const windows = { ...info.unifiedWindows };
	const { rateLimitType, utilization } = info;
	if (rateLimitType && Object.hasOwn(WINDOW_ABBREVIATIONS, rateLimitType) && utilization !== undefined) {
		windows[rateLimitType] ??= { utilization, resetsAt: info.resetsAt };
	}
	for (const [name, window] of Object.entries(windows)) {
		const abbreviation = WINDOW_ABBREVIATIONS[name] ?? name;
		set(`${abbreviation}-utilization`, window?.utilization);
		set(`${abbreviation}-reset`, window?.resetsAt);
	}
	// After the windows, so an explicit overage reset wins over the event's generic one.
	set("overage-reset", info.overageResetsAt);

	return { status: HTTP_OK, headers };
}
