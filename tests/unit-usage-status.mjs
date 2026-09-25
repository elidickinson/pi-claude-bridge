/**
 * Subscription usage status: every rate_limit_event Claude Code sends carries the plan's
 * usage windows in `unifiedWindows` (undocumented in sdk.d.ts; the event below is taken
 * from a recorded fixture). The bridge shows them in pi's footer via setStatus and saves
 * the latest snapshot so the next session starts with it.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";
import {
	formatUsageDetails,
	formatUsageStatus,
	loadUsageSnapshot,
	mergeUsageSnapshot,
	saveUsageSnapshot,
	snapshotFromRateLimitInfo,
	usageChanged,
} from "../src/usage-status.js";

const { __test } = await import("../src/index.js");

const fixtureEvent = readFileSync(new URL("./fixtures/sdk-streams/text.jsonl", import.meta.url), "utf-8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.find((m) => m.type === "rate_limit_event");
const info = fixtureEvent.rate_limit_info;
const FIVE_HOUR_RESET = info.unifiedWindows.five_hour.resetsAt;
const SEVEN_DAY_RESET = info.unifiedWindows.seven_day.resetsAt;
// An hour before the 5-hour window resets; the 7-day reset is days away.
const NOW = (FIVE_HOUR_RESET - 3600) * 1000;

describe("snapshotFromRateLimitInfo", () => {
	it("reads every window from unifiedWindows", () => {
		const s = snapshotFromRateLimitInfo(info, NOW);
		assert.deepStrictEqual(s.windows, {
			five_hour: { utilization: 0.14, resetsAt: FIVE_HOUR_RESET },
			seven_day: { utilization: 0.01, resetsAt: SEVEN_DAY_RESET },
		});
		assert.strictEqual(s.observedAt, NOW);
		assert.strictEqual(s.overageStatus, "allowed");
	});

	it("falls back to the single window named by rateLimitType", () => {
		const s = snapshotFromRateLimitInfo({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.82, resetsAt: SEVEN_DAY_RESET }, NOW);
		assert.deepStrictEqual(s.windows, { seven_day: { utilization: 0.82, resetsAt: SEVEN_DAY_RESET } });
	});

	it("reports nothing for an event without utilization", () => {
		assert.strictEqual(snapshotFromRateLimitInfo({ status: "allowed", resetsAt: FIVE_HOUR_RESET, rateLimitType: "five_hour" }, NOW), null);
		assert.strictEqual(snapshotFromRateLimitInfo(undefined, NOW), null);
	});
});

describe("mergeUsageSnapshot", () => {
	it("keeps a window the newer event omits", () => {
		const full = snapshotFromRateLimitInfo(info, NOW);
		const partial = snapshotFromRateLimitInfo({ rateLimitType: "five_hour", utilization: 0.5, resetsAt: FIVE_HOUR_RESET }, NOW + 1000);
		const merged = mergeUsageSnapshot(full, partial);
		assert.strictEqual(merged.windows.five_hour.utilization, 0.5);
		assert.strictEqual(merged.windows.seven_day.utilization, 0.01);
		assert.strictEqual(merged.observedAt, NOW + 1000);
		assert.strictEqual(merged.overageStatus, "allowed");
	});
});

describe("formatUsageStatus", () => {
	it("shows each live window with its reset: clock time within a day, date beyond", () => {
		const text = formatUsageStatus(snapshotFromRateLimitInfo(info, NOW), NOW);
		assert.match(text, /^Claude 5h 14% ↻\d\d:\d\d · 7d 1% ↻\d{1,2}\/\d{1,2}$/);
	});

	it("drops a window whose reset time has passed", () => {
		const afterFiveHour = (FIVE_HOUR_RESET + 60) * 1000;
		const text = formatUsageStatus(snapshotFromRateLimitInfo(info, NOW), afterFiveHour);
		assert.match(text, /^Claude 7d 1% ↻/);
	});

	it("clears the status once every window has reset", () => {
		assert.strictEqual(formatUsageStatus(snapshotFromRateLimitInfo(info, NOW), (SEVEN_DAY_RESET + 60) * 1000), undefined);
		assert.strictEqual(formatUsageStatus(null, NOW), undefined);
	});

	it("orders known windows first and labels unknown ones by name", () => {
		const s = snapshotFromRateLimitInfo({ unifiedWindows: {
			seven_day_opus: { utilization: 0.3 },
			future_window: { utilization: 0.2 },
			five_hour: { utilization: 0.1 },
		} }, NOW);
		assert.strictEqual(formatUsageStatus(s, NOW), "Claude 5h 10% · 7d Opus 30% · future_window 20%");
	});
});

describe("formatUsageDetails", () => {
	it("lists windows, time to reset, and extra usage", () => {
		const s = snapshotFromRateLimitInfo({ ...info, overageStatus: "rejected", overageDisabledReason: "out_of_credits" }, NOW);
		const text = formatUsageDetails(s, NOW + 5 * 60000);
		assert.match(text, /reported .*, 5m ago/);
		assert.match(text, /5h: 14% — resets .* \(in 55m\)/);
		assert.match(text, /7d: 1% — resets .* \(in 3d \d+h\)/);
		assert.match(text, /Extra usage: rejected \(out_of_credits\)/);
	});

	it("says usage is unknown for a window that has since reset", () => {
		const text = formatUsageDetails(snapshotFromRateLimitInfo(info, NOW), (FIVE_HOUR_RESET + 60) * 1000);
		assert.match(text, /5h: 14% — reset at .*; current usage unknown until the next request/);
	});

	it("explains where usage comes from before any is reported", () => {
		assert.match(formatUsageDetails(null, NOW), /nothing reported yet/);
	});
});

describe("usageChanged", () => {
	const s = snapshotFromRateLimitInfo(info, NOW);
	it("ignores the observation time and sub-percent noise", () => {
		const later = snapshotFromRateLimitInfo({ ...info, unifiedWindows: { ...info.unifiedWindows, five_hour: { utilization: 0.1404, resetsAt: FIVE_HOUR_RESET } } }, NOW + 5000);
		assert.strictEqual(usageChanged(s, later), false);
	});
	it("sees a new percent or a new window", () => {
		const moved = snapshotFromRateLimitInfo({ ...info, unifiedWindows: { ...info.unifiedWindows, five_hour: { utilization: 0.2, resetsAt: FIVE_HOUR_RESET } } }, NOW);
		assert.strictEqual(usageChanged(s, moved), true);
		assert.strictEqual(usageChanged(null, s), true);
	});
});

describe("snapshot file", () => {
	const path = process.env.CLAUDE_BRIDGE_USAGE_PATH;
	beforeEach(() => rmSync(path, { force: true }));

	it("round-trips", () => {
		const s = snapshotFromRateLimitInfo(info, NOW);
		saveUsageSnapshot(path, s);
		assert.deepStrictEqual(loadUsageSnapshot(path), s);
	});

	it("reads a missing or corrupt file as no snapshot", () => {
		assert.strictEqual(loadUsageSnapshot(path), null);
		writeFileSync(path, "{not json");
		assert.strictEqual(loadUsageSnapshot(path), null);
		writeFileSync(path, JSON.stringify({ windows: {} }));
		assert.strictEqual(loadUsageSnapshot(path), null);
	});
});

describe("a rate_limit_event reaching consumeQuery", () => {
	const path = process.env.CLAUDE_BRIDGE_USAGE_PATH;
	const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

	beforeEach(() => {
		rmSync(path, { force: true });
		__test.resetUsage();
	});

	async function consume(messages, statuses) {
		__test.setPiUI({ notify: () => {}, setStatus: (key, text) => statuses.push([key, text]) });
		const c = new QueryContext();
		c.currentPiStream = { push: () => {}, end: () => {} };
		c.resetTurnState(fakeModel);
		async function* gen() { for (const m of messages) yield m; }
		try {
			await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c);
		} finally {
			__test.setPiUI(null);
		}
	}

	it("updates the footer status and saves the snapshot", async () => {
		const statuses = [];
		// A future reset keeps both windows live whenever this runs.
		const inAnHour = Math.floor(Date.now() / 1000) + 3600;
		const inAWeek = inAnHour + 6 * 24 * 3600;
		const event = { ...fixtureEvent, rate_limit_info: { ...info, unifiedWindows: {
			five_hour: { utilization: 0.14, resetsAt: inAnHour },
			seven_day: { utilization: 0.01, resetsAt: inAWeek },
		} } };
		await consume([event], statuses);

		assert.strictEqual(statuses.length, 1);
		assert.strictEqual(statuses[0][0], "claude-usage");
		assert.match(statuses[0][1], /^Claude 5h 14% ↻\d\d:\d\d · 7d 1% ↻/);
		assert.ok(existsSync(path), "snapshot saved");
		assert.deepStrictEqual(loadUsageSnapshot(path).windows, __test.getUsageSnapshot().windows);
	});

	it("leaves the status alone for an event without usage", async () => {
		const statuses = [];
		await consume([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } }], statuses);
		assert.deepStrictEqual(statuses, []);
		assert.strictEqual(existsSync(path), false);
	});
});
