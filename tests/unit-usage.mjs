import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyRateLimitInfo,
	formatPanel,
	formatReset,
	formatResetClock,
	formatResetDay,
	formatStatus,
} from "../src/usage.js";

function snap(windows, extraUsage) {
	return { windows, extraUsage, fetchedAt: new Date() };
}

describe("formatReset", () => {
	const now = new Date("2026-07-03T09:00:00Z");
	it("shows minutes under an hour", () => {
		assert.equal(formatReset(new Date("2026-07-03T09:40:00Z"), now), "resets in 40m");
	});
	it("shows hours and minutes under a day", () => {
		assert.equal(formatReset(new Date("2026-07-03T12:30:00Z"), now), "resets in 3h 30m");
	});
	it("shows days and hours beyond a day", () => {
		assert.equal(formatReset(new Date("2026-07-05T11:00:00Z"), now), "resets in 2d 2h");
	});
	it("handles past/undefined", () => {
		assert.equal(formatReset(new Date("2026-07-03T08:00:00Z"), now), "resetting");
		assert.equal(formatReset(undefined, now), "");
	});
});

describe("formatResetClock / formatResetDay", () => {
	// Local-time constructor so formatting is timezone-independent.
	const d = new Date(2026, 6, 3, 9, 5); // 2026-07-03 09:05 local (a Friday)
	it("clock is zero-padded HH:MM", () => assert.equal(formatResetClock(d), "09:05"));
	it("day is a short weekday", () => assert.match(formatResetDay(d), /^[A-Za-z]{3}/));
	it("empty for undefined", () => {
		assert.equal(formatResetClock(undefined), "");
		assert.equal(formatResetDay(undefined), "");
	});
});

describe("formatStatus", () => {
	it("shows percent used with per-window reset hints, session + weekly only", () => {
		const s = snap([
			{ key: "five_hour", label: "5h", utilization: 19, remaining: 81, resetsAt: new Date(2026, 6, 3, 12, 50) },
			{ key: "seven_day", label: "7d", utilization: 21, remaining: 79, resetsAt: new Date(2026, 6, 6, 0, 0) },
			{ key: "seven_day_opus", label: "7d Opus", utilization: 5, remaining: 95 },
		]);
		assert.match(formatStatus(s), /^Claude 5h 19% \(Res\. 12:50\) · 7d 21% \(Res\. [A-Za-z]{3}\)$/);
	});
	it("omits the reset hint when unknown", () => {
		const s = snap([{ key: "five_hour", label: "5h", utilization: 19, remaining: 81 }]);
		assert.equal(formatStatus(s), "Claude 5h 19%");
	});
});

describe("formatPanel", () => {
	const now = new Date("2026-07-03T09:00:00Z");
	it("renders each window with used% and reset, plus extra usage", () => {
		const s = snap(
			[{ key: "five_hour", label: "5h", utilization: 13, remaining: 87, resetsAt: new Date("2026-07-03T12:00:00Z") }],
			"extra usage 4% used",
		);
		const out = formatPanel(s, now);
		assert.match(out, /Claude subscription usage/);
		assert.match(out, /5h\s+87% left\s+\(13% used, resets in 3h 0m\)/);
		assert.match(out, /extra usage 4% used/);
	});
});

describe("applyRateLimitInfo", () => {
	it("creates a snapshot from a passive event when none exists", () => {
		const s = applyRateLimitInfo(null, { rateLimitType: "five_hour", utilization: 42 });
		assert.equal(s.windows.length, 1);
		assert.equal(s.windows[0].key, "five_hour");
		assert.equal(s.windows[0].remaining, 58);
	});
	it("updates the matching window in place, preserving prior reset if event lacks one", () => {
		const base = snap([
			{ key: "five_hour", label: "5h", utilization: 13, remaining: 87, resetsAt: new Date("2026-07-03T12:00:00Z") },
			{ key: "seven_day", label: "7d", utilization: 20, remaining: 80 },
		]);
		const s = applyRateLimitInfo(base, { rateLimitType: "five_hour", utilization: 90 });
		const w = s.windows.find((x) => x.key === "five_hour");
		assert.equal(w.remaining, 10);
		assert.equal(w.resetsAt.toISOString(), "2026-07-03T12:00:00.000Z");
		assert.equal(s.windows.length, 2);
	});
	it("clamps utilization into 0-100", () => {
		const s = applyRateLimitInfo(null, { rateLimitType: "seven_day", utilization: 130 });
		assert.equal(s.windows[0].utilization, 100);
		assert.equal(s.windows[0].remaining, 0);
	});
	it("ignores events with no type or non-numeric utilization", () => {
		assert.equal(applyRateLimitInfo(null, { utilization: 10 }), null);
		assert.equal(applyRateLimitInfo(null, { rateLimitType: "five_hour" }), null);
	});
});
