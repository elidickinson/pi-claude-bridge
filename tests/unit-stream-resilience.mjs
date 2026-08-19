import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import {
	DEFAULT_STALL_TIMEOUT_MS,
	classifyFailure,
	decideRetry,
	stallTimeoutMs,
	StreamMonitor,
	StreamStalledError,
} from "../src/stream-resilience.js";

const { __test } = await import("../src/index.js");

const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-5" };
const LIMIT_TEXT = "You've hit your limit · resets 9am (Europe/Paris)";
const OVERLOAD_TEXT = "Server is temporarily limiting requests (not your usage limit): Rate limited";
const asPiMessage = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });

function harness() {
	const events = [];
	const context = new QueryContext();
	context.currentPiStream = { push: (event) => events.push(event), end: () => events.push({ type: "end" }) };
	context.resetTurnState(model);
	return { context, events };
}

async function* streamOf(messages) {
	for (const message of messages) yield message;
}

async function* failedStream(error) {
	yield* [];
	throw error;
}

describe("subscription limit fallback", () => {
	it("rewrites Claude's limit text into a failure Pi classifies as retryable", () => {
		assert.equal(isRetryableAssistantError(asPiMessage(LIMIT_TEXT)), false);
		const classified = classifyFailure(LIMIT_TEXT);
		assert.equal(classified.kind, "rate-limit");
		assert.equal(isRetryableAssistantError(asPiMessage(classified.message)), true);
	});

	it("uses a rejected rate-limit event for opaque failures", async () => {
		const { context } = harness();
		context.streamMonitor = new StreamMonitor({ idleMs: 0, hasPendingWork: () => false, onStall: () => {} });
		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "rejected", resetsAt: 0 } },
			{ type: "result", subtype: "success", is_error: true, result: "Claude Code failed: error_during_execution" },
		]), new Map(), model, () => false, context);

		assert.equal(context.streamMonitor.rateLimitRejected, true);
		assert.equal(context.turnOutput.stopReason, "error");
		assert.equal(isRetryableAssistantError(asPiMessage(context.turnOutput.errorMessage)), true);
	});

	it("does not let non-retryable wording defeat fallback classification", () => {
		const classified = classifyFailure("You've hit your limit · enable available balance to continue");
		assert.equal(classified.kind, "rate-limit");
		assert.doesNotMatch(classified.message, /available balance/);
		assert.equal(isRetryableAssistantError(asPiMessage(classified.message)), true);
	});

	it("never retries subscription, auth, billing, or permission failures", () => {
		for (const text of [LIMIT_TEXT, "401 Unauthorized", "Credit balance is too low", "permission denied"]) {
			const decision = decideRetry({ failure: new Error(text), outputStarted: false, retriesUsed: 0 });
			assert.equal(decision.retry, false, text);
		}
	});
});

describe("transient overload retry", () => {
	it("retries exactly once before output and then succeeds", async () => {
		const { context, events } = harness();
		let starts = 0;
		let restarts = 0;
		const attempt = {
			current: () => {
				starts++;
				if (starts === 1) return failedStream(new Error(OVERLOAD_TEXT));
				return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
			},
			restart: () => { restarts++; },
			abort: () => {},
		};

		await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, context);

		assert.equal(starts, 2);
		assert.equal(restarts, 1);
		assert.equal(context.turnOutput.stopReason, "stop");
		assert.equal(context.turnOutput.errorMessage, undefined);
		assert.deepEqual(events.filter((event) => event.type === "text_end").map((event) => event.content), ["recovered"]);
	});

	it("retries transient error results as well as rejected queries", async () => {
		const { context } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				if (starts === 1) return streamOf([{ type: "result", subtype: "success", is_error: true, result: OVERLOAD_TEXT }]);
				return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
			},
			restart: () => {},
			abort: () => {},
		};

		await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, context);
		assert.equal(starts, 2);
		assert.equal(context.turnOutput.stopReason, "stop");
	});

	it("does not retry after output starts", async () => {
		const { context, events } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				return (async function* () {
					yield { type: "assistant", message: { content: [{ type: "text", text: "partial answer" }], stop_reason: "end_turn" } };
					throw new Error(OVERLOAD_TEXT);
				})();
			},
			restart: () => { assert.fail("must not restart after output"); },
			abort: () => {},
		};

		await assert.rejects(
			__test.consumeQueryWithRetry(attempt, new Map(), model, () => false, context),
			/temporarily limiting requests/,
		);
		assert.equal(starts, 1);
		assert.deepEqual(events.filter((event) => event.type === "text_end").map((event) => event.content), ["partial answer"]);
	});

	it("stops after one failed retry", async () => {
		const { context } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				return failedStream(new Error(OVERLOAD_TEXT));
			},
			restart: () => {},
			abort: () => {},
		};

		await assert.rejects(
			__test.consumeQueryWithRetry(attempt, new Map(), model, () => false, context),
			/temporarily limiting requests/,
		);
		assert.equal(starts, 2);
	});
});

describe("idle stall watchdog", () => {
	it("parses the timeout override without turning junk into an immediate stall", () => {
		assert.equal(stallTimeoutMs({}), DEFAULT_STALL_TIMEOUT_MS);
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "250" }), 250);
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "0" }), 0);
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "junk" }), DEFAULT_STALL_TIMEOUT_MS);
	});

	it("waits through pending tool work, then stalls after the stream goes idle", async () => {
		let pending = true;
		let stalled;
		const monitor = new StreamMonitor({
			idleMs: 20,
			hasPendingWork: () => pending,
			onStall: (error) => { stalled = error; },
		});
		monitor.arm();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(stalled, undefined);

		pending = false;
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(stalled instanceof StreamStalledError);
	});

	it("aborts and retries a stalled query once", async () => {
		const previous = process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
		process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS = "20";
		const keepAlive = setInterval(() => {}, 1_000);
		try {
			const { context } = harness();
			let starts = 0;
			let release;
			const attempt = {
				current: () => {
					starts++;
					if (starts === 2) return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
					return (async function* () {
						await new Promise((resolve) => { release = resolve; });
					})();
				},
				restart: () => {},
				abort: () => release?.(),
			};

			await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, context);
			assert.equal(starts, 2);
			assert.equal(context.turnOutput.stopReason, "stop");
		} finally {
			clearInterval(keepAlive);
			if (previous === undefined) delete process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
			else process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS = previous;
		}
	});
});
