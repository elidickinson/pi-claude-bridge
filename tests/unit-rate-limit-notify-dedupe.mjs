/**
 * Rate-limit notification dedupe: N concurrent SDK streams (one per subagent)
 * each carry their own `rate_limit_event` frames for the same account-wide
 * state, and a single long-running stream re-emits the event as its headers
 * refresh. Both sources must collapse into one `piUI.notify` call per distinct
 * state, while the per-stream watchdog (`noteRateLimitEvent`) and debug log
 * keep firing on every event regardless.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { StreamMonitor } from "../src/stream-resilience.js";

const { __test } = await import("../src/index.js");

const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-5" };

function harness() {
	const c = new QueryContext();
	c.currentPiStream = { push: () => {}, end: () => {} };
	c.resetTurnState(model);
	const rateLimitEvents = [];
	c.streamMonitor = new StreamMonitor({ idleMs: 0, hasPendingWork: () => false, onStall: () => {} });
	const originalNote = c.streamMonitor.noteRateLimitEvent.bind(c.streamMonitor);
	c.streamMonitor.noteRateLimitEvent = (info) => {
		rateLimitEvents.push(info);
		return originalNote(info);
	};
	return { c, rateLimitEvents };
}

async function* streamOf(messages) {
	for (const m of messages) yield m;
}

describe("rate-limit warning notify dedupe", () => {
	let notices;

	beforeEach(() => {
		notices = [];
		__test.setPiUI({ notify: (message, kind) => notices.push({ message, kind }) });
		__test.resetRateLimitNotifyDedupe();
	});

	it("collapses identical allowed_warning events from concurrent streams into one notify", async () => {
		const { c: c1, rateLimitEvents: events1 } = harness();
		const { c: c2, rateLimitEvents: events2 } = harness();
		const { c: c3, rateLimitEvents: events3 } = harness();
		const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } };

		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c1, []);
		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c2, []);
		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c3, []);

		assert.deepEqual(notices, [{ message: "Claude rate limit warning: 78% used (seven_day)", kind: "warning" }]);
		assert.equal(events1.length, 1, "per-stream watchdog still sees its own event");
		assert.equal(events2.length, 1, "per-stream watchdog still sees its own event");
		assert.equal(events3.length, 1, "per-stream watchdog still sees its own event");
	});

	it("collapses identical allowed_warning events re-emitted within one long stream", async () => {
		const { c } = harness();
		const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } };

		await __test.consumeQuery(streamOf([event, event, event]), new Map(), model, () => false, c, []);

		assert.deepEqual(notices, [{ message: "Claude rate limit warning: 78% used (seven_day)", kind: "warning" }]);
	});

	it("notifies again when the rounded utilization percentage changes", async () => {
		const { c } = harness();

		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.77 } },
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } },
		]), new Map(), model, () => false, c, []);

		assert.deepEqual(notices, [
			{ message: "Claude rate limit warning: 77% used (seven_day)", kind: "warning" },
			{ message: "Claude rate limit warning: 78% used (seven_day)", kind: "warning" },
		]);
	});

	it("notifies again when the rateLimitType changes at the same percentage", async () => {
		const { c } = harness();

		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } },
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.78 } },
		]), new Map(), model, () => false, c, []);

		assert.deepEqual(notices, [
			{ message: "Claude rate limit warning: 78% used (seven_day)", kind: "warning" },
			{ message: "Claude rate limit warning: 78% used (five_hour)", kind: "warning" },
		]);
	});

	it("collapses two buckets alternating across concurrent streams into one notify each", async () => {
		const sevenDay = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } };
		const fiveHour = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.4 } };

		for (const event of [sevenDay, fiveHour, sevenDay, fiveHour]) {
			const { c } = harness();
			await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c, []);
		}

		assert.deepEqual(notices, [
			{ message: "Claude rate limit warning: 78% used (seven_day)", kind: "warning" },
			{ message: "Claude rate limit warning: 40% used (five_hour)", kind: "warning" },
		]);
	});

	it("notifies again when status escalates from allowed_warning to rejected", async () => {
		const { c } = harness();

		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } },
			{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 0 } },
		]), new Map(), model, () => false, c, []);

		assert.equal(notices.length, 2);
		assert.equal(notices[0].message, "Claude rate limit warning: 78% used (seven_day)");
		assert.match(notices[1].message, /^Claude rate limited \(seven_day\) — resets at /);
	});

	it("collapses identical rejected events across concurrent streams", async () => {
		const { c: c1 } = harness();
		const { c: c2 } = harness();
		const event = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage", resetsAt: 0 } };

		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c1, []);
		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c2, []);

		assert.equal(notices.length, 1);
	});

	it("resets after clearSession-equivalent teardown so a new session sees the warning again", async () => {
		const { c: c1 } = harness();
		const { c: c2 } = harness();
		const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.78 } };

		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c1, []);
		__test.resetRateLimitNotifyDedupe();
		await __test.consumeQuery(streamOf([event]), new Map(), model, () => false, c2, []);

		assert.equal(notices.length, 2);
	});
});
