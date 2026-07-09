/**
 * Tests for subscription quota formatting. Verifies the footer status and the
 * /usage report render only the windows the SDK actually streamed, and that
 * absent windows are never referenced.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatQuotaStatus, formatUsageReport, anyExtraUsageActive, usageBar } from "../src/usage.js";

const sample = (fields) => ({ status: "allowed", capturedAt: Date.now(), ...fields });

describe("usageBar", () => {
	it("fills proportionally and stays fixed width", () => {
		assert.equal(usageBar(0, 10), "░░░░░░░░░░");
		assert.equal(usageBar(50, 10), "▓▓▓▓▓░░░░░");
		assert.equal(usageBar(100, 10), "▓▓▓▓▓▓▓▓▓▓");
	});
	it("clamps out-of-range values", () => {
		assert.equal(usageBar(150, 10), "▓▓▓▓▓▓▓▓▓▓");
		assert.equal(usageBar(-5, 10), "░░░░░░░░░░");
	});
});

describe("formatQuotaStatus", () => {
	it("returns undefined with no five-hour sample", () => {
		assert.equal(formatQuotaStatus(new Map()), undefined);
		const weeklyOnly = new Map([["seven_day", sample({ rateLimitType: "seven_day", utilization: 10 })]]);
		assert.equal(formatQuotaStatus(weeklyOnly), undefined);
	});

	it("renders the five-hour utilization", () => {
		const windows = new Map([["five_hour", sample({ rateLimitType: "five_hour", utilization: 33.6 })]]);
		assert.equal(formatQuotaStatus(windows), "CC 5h 34%");
	});

	it("flags active extra usage", () => {
		const windows = new Map([
			["five_hour", sample({ rateLimitType: "five_hour", utilization: 80, isUsingOverage: true })],
		]);
		assert.ok(formatQuotaStatus(windows).includes("extra"));
	});
});

describe("formatUsageReport", () => {
	it("reports no data for an empty map", () => {
		assert.match(formatUsageReport(new Map()), /no data yet/);
	});

	it("renders only windows that streamed in, in canonical order", () => {
		const windows = new Map([
			["seven_day", sample({ rateLimitType: "seven_day", utilization: 12, resetsAt: 1785542400000 })],
			["five_hour", sample({ rateLimitType: "five_hour", utilization: 50, resetsAt: 1783632000000 })],
		]);
		const report = formatUsageReport(windows);
		const fiveIdx = report.indexOf("5-hour");
		const weekIdx = report.indexOf("weekly");
		assert.ok(fiveIdx !== -1 && weekIdx !== -1, "both windows present");
		assert.ok(fiveIdx < weekIdx, "five-hour listed before weekly");
		assert.match(report, /5-hour  ▓+░+   50%  resets/);
	});

	it("does not reference windows that never streamed in", () => {
		const windows = new Map([["five_hour", sample({ rateLimitType: "five_hour", utilization: 7 })]]);
		const report = formatUsageReport(windows);
		assert.ok(report.includes("5-hour"), "shows the window it has");
		assert.ok(!report.includes("weekly"), "no phantom weekly bar");
		assert.ok(!/not seen|unavailable/.test(report), "no placeholder text for absent windows");
	});

	it("reports extra usage in use when any window is on overage", () => {
		const windows = new Map([
			["five_hour", sample({ rateLimitType: "five_hour", utilization: 100, isUsingOverage: true })],
		]);
		assert.ok(anyExtraUsageActive(windows));
		assert.match(formatUsageReport(windows), /Extra Usage: in use/);
	});
});
