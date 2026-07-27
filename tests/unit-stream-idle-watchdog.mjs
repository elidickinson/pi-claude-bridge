import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

function halfOpenQuery() {
	let finish;
	return {
		interruptCount: 0,
		closeCount: 0,
		[Symbol.asyncIterator]() { return this; },
		next() { return new Promise((resolve) => { finish = resolve; }); },
		interrupt() { this.interruptCount++; return Promise.resolve(); },
		close() { this.closeCount++; finish?.({ done: true }); },
	};
}

async function withShortTimeouts(run) {
	const previousIdle = process.env.CLAUDE_BRIDGE_IDLE_TIMEOUT_MS;
	const previousFirst = process.env.CLAUDE_BRIDGE_FIRST_TOKEN_TIMEOUT_MS;
	process.env.CLAUDE_BRIDGE_IDLE_TIMEOUT_MS = "10";
	process.env.CLAUDE_BRIDGE_FIRST_TOKEN_TIMEOUT_MS = "10";
	try {
		await run();
	} finally {
		if (previousIdle === undefined) delete process.env.CLAUDE_BRIDGE_IDLE_TIMEOUT_MS;
		else process.env.CLAUDE_BRIDGE_IDLE_TIMEOUT_MS = previousIdle;
		if (previousFirst === undefined) delete process.env.CLAUDE_BRIDGE_FIRST_TOKEN_TIMEOUT_MS;
		else process.env.CLAUDE_BRIDGE_FIRST_TOKEN_TIMEOUT_MS = previousFirst;
	}
}

describe("stream idle watchdog", () => {
	it("interrupts a half-open SDK query and returns a provider error", async () => {
		await withShortTimeouts(async () => {
			const query = halfOpenQuery();
			await assert.rejects(
				__test.consumeQuery(query, new Map(), {}, () => false, new QueryContext()),
				/Claude SDK stream stalled: no first-token activity for 10ms/,
			);
			assert.equal(query.interruptCount, 1);
			assert.equal(query.closeCount, 1);
		});
	});

	it("does not interrupt while a pi tool call is pending", async () => {
		await withShortTimeouts(async () => {
			const query = halfOpenQuery();
			const context = new QueryContext();
			context.pendingToolCalls.set("tool-1", {});
			const result = __test.consumeQuery(query, new Map(), {}, () => false, context);

			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.equal(query.interruptCount, 0);
			context.pendingToolCalls.clear();

			await assert.rejects(result, /Claude SDK stream stalled/);
			assert.equal(query.interruptCount, 1);
		});
	});
});
