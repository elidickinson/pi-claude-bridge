#!/usr/bin/env node
// Unit tests for the provider-usage bus (usage-bus.ts): the bridge publishes the
// rate_limit_event windows it receives; it never renders them itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CLAUDE_BRIDGE_ADAPTER_ID,
	PROVIDER_USAGE_BUS_SYMBOL,
	createClaudeUsageTracker,
	getProviderUsageBus,
	windowsFromRateLimitInfo,
} from "../src/usage-bus.js";

const NOW = 1_790_000_000_000;

// Verbatim shape of a rate_limit_event from Claude Code 2.1.280 (utilization
// lives under unifiedWindows; the top level only names the flagged window).
const LIVE_EVENT = {
	status: "allowed",
	resetsAt: 1_790_361_600,
	rateLimitType: "five_hour",
	overageStatus: "rejected",
	overageDisabledReason: "org_level_disabled",
	isUsingOverage: false,
	unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1_790_361_600 }, seven_day: { utilization: 0.04, resetsAt: 1_790_845_200 } },
};

function freshGlobal() {
	return {};
}

describe("getProviderUsageBus", () => {
	it("creates the bus at the well-known symbol once and reuses it", () => {
		const g = freshGlobal();
		const bus = getProviderUsageBus(g);
		assert.equal(g[PROVIDER_USAGE_BUS_SYMBOL], bus);
		assert.equal(getProviderUsageBus(g), bus);
		assert.equal(bus.version, 1);
	});

	it("reuses a bus another extension already published", () => {
		const g = freshGlobal();
		const foreign = { register() {}, adapters: () => [], subscribe() {}, publish() {} };
		g[PROVIDER_USAGE_BUS_SYMBOL] = foreign;
		assert.equal(getProviderUsageBus(g), foreign);
	});

	it("replaces a value at the symbol that is not bus-shaped", () => {
		const g = freshGlobal();
		g[PROVIDER_USAGE_BUS_SYMBOL] = { register() {} };
		const bus = getProviderUsageBus(g);
		assert.equal(typeof bus.subscribe, "function");
		assert.equal(g[PROVIDER_USAGE_BUS_SYMBOL], bus);
	});

	it("register replaces by id and unregister only removes its own entry", () => {
		const bus = getProviderUsageBus(freshGlobal());
		const first = { id: "a", usageProvider: "x", modelProviders: [], refresh: async () => undefined };
		const second = { ...first };
		const unregisterFirst = bus.register(first);
		bus.register(second);
		assert.deepEqual(bus.adapters(), [second]);
		unregisterFirst();
		assert.deepEqual(bus.adapters(), [second], "a stale unregister must not remove the replacement");
	});

	it("publish reaches every listener and survives a throwing one", () => {
		const bus = getProviderUsageBus(freshGlobal());
		const seen = [];
		bus.subscribe(() => {
			throw new Error("consumer bug");
		});
		const unsubscribe = bus.subscribe((event) => seen.push(event));
		bus.publish({ adapterId: "a", snapshot: { version: 1 } });
		assert.equal(seen.length, 1);
		unsubscribe();
		bus.publish({ adapterId: "a", snapshot: { version: 1 } });
		assert.equal(seen.length, 1);
	});
});

describe("windowsFromRateLimitInfo", () => {
	it("reads every window out of a live unifiedWindows event", () => {
		const windows = windowsFromRateLimitInfo(LIVE_EVENT, NOW);
		assert.deepEqual(windows, [
			{ id: "five_hour", usedPercent: 13, windowMinutes: 300, resetsAt: 1_790_361_600, state: "allowed", capturedAt: NOW },
			{ id: "seven_day", usedPercent: 4, windowMinutes: 7 * 24 * 60, resetsAt: 1_790_845_200, state: "allowed", capturedAt: NOW },
		]);
	});

	it("applies the top-level status only to the flagged window and skips malformed entries", () => {
		const windows = windowsFromRateLimitInfo(
			{ status: "allowed_warning", rateLimitType: "seven_day_opus", resetsAt: 5, unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day_opus: { utilization: 0.9 }, per_minute: { utilization: 0.5 }, seven_day: "nope", overage: { utilization: 1 } } },
			NOW,
		);
		const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
		assert.deepEqual(Object.keys(byId).sort(), ["five_hour", "seven_day_opus"]);
		assert.equal(byId.five_hour.state, "allowed");
		assert.equal(byId.seven_day_opus.state, "allowed_warning");
		assert.equal(byId.seven_day_opus.resetsAt, 5, "the flagged window borrows the top-level reset when its own is missing");
		assert.deepEqual(byId.seven_day_opus.scope, { kind: "model", label: "Opus" });
	});

	it("falls back to the single top-level window of an older event", () => {
		const windows = windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.63, resetsAt: 1_790_245_200 }, NOW);
		assert.deepEqual(windows, [{ id: "five_hour", usedPercent: 63, windowMinutes: 300, resetsAt: 1_790_245_200, state: "allowed", capturedAt: NOW }]);
		const included = windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.1 }, NOW);
		assert.equal(included[0].windowMinutes, 7 * 24 * 60);
		assert.equal(included[0].scope, undefined);
		assert.equal(included[0].resetsAt, null);
	});

	it("clamps utilization and treats a missing one as zero", () => {
		assert.equal(windowsFromRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", utilization: 1.4 }, NOW)[0].usedPercent, 100);
		assert.equal(windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "five_hour" }, NOW)[0].usedPercent, 0);
	});

	it("skips the overage flag and unknown window types", () => {
		assert.deepEqual(windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "overage", utilization: 0.2 }, NOW), []);
		assert.deepEqual(windowsFromRateLimitInfo({ status: "allowed", rateLimitType: "per_minute", utilization: 0.2 }, NOW), []);
		assert.deepEqual(windowsFromRateLimitInfo({ status: "allowed" }, NOW), []);
	});
});

describe("createClaudeUsageTracker", () => {
	it("exposes an adapter that resolves the latest snapshot without any network", async () => {
		const bus = getProviderUsageBus(freshGlobal());
		const tracker = createClaudeUsageTracker(bus, () => NOW);
		assert.equal(tracker.adapter.id, CLAUDE_BRIDGE_ADAPTER_ID);
		assert.equal(tracker.adapter.usageProvider, "claude");
		assert.deepEqual([...tracker.adapter.modelProviders], ["claude-bridge"]);
		assert.equal(await tracker.adapter.refresh({ timeoutMs: 10 }), undefined, "no sample yet, no snapshot");
		tracker.record(LIVE_EVENT);
		const snapshot = await tracker.adapter.refresh();
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.provider, "claude");
		assert.equal(snapshot.adapterId, CLAUDE_BRIDGE_ADAPTER_ID);
		assert.equal(snapshot.capturedAt, NOW);
		assert.equal(snapshot.overageInUse, false);
		assert.deepEqual(snapshot.windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 13], ["seven_day", 4]]);
	});

	it("fills in one window per event and keeps the latest sample per window", () => {
		const bus = getProviderUsageBus(freshGlobal());
		const published = [];
		bus.subscribe((event) => published.push(event));
		const tracker = createClaudeUsageTracker(bus, () => NOW);
		tracker.record({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 }, NOW);
		tracker.record({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4 }, NOW + 1);
		tracker.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8 }, NOW + 2);
		assert.equal(published.length, 3);
		const last = published.at(-1);
		assert.equal(last.adapterId, CLAUDE_BRIDGE_ADAPTER_ID);
		assert.equal(last.snapshot.capturedAt, NOW + 2);
		const byId = Object.fromEntries(last.snapshot.windows.map((w) => [w.id, w]));
		assert.equal(byId.five_hour.usedPercent, 80);
		assert.equal(byId.five_hour.state, "allowed_warning");
		assert.equal(byId.seven_day.usedPercent, 40);
		assert.equal(tracker.snapshot(), last.snapshot);
	});

	it("carries the overage flag and publishes nothing for a sample with no window and no overage", () => {
		const bus = getProviderUsageBus(freshGlobal());
		const published = [];
		bus.subscribe((event) => published.push(event));
		const tracker = createClaudeUsageTracker(bus, () => NOW);
		tracker.record({ status: "allowed", rateLimitType: "per_minute", utilization: 0.1 });
		assert.equal(published.length, 0);
		tracker.record({ status: "allowed", rateLimitType: "overage", isUsingOverage: true });
		assert.equal(published.length, 1);
		assert.equal(published[0].snapshot.overageInUse, true);
		assert.deepEqual(published[0].snapshot.windows, []);
		tracker.record({ status: "allowed", rateLimitType: "overage", isUsingOverage: true });
		assert.equal(published.length, 1, "a sample that changes nothing publishes nothing");
		tracker.record(null);
		tracker.record(undefined);
		assert.equal(published.length, 1, "malformed samples are ignored");
	});
});
