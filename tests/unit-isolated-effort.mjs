/**
 * One-off calls (cacheRetention "none": compaction, branch summary, extension
 * one-shots) take the isolated path. It used to drop the caller's reasoning
 * level, so Claude Code always ran at its default effort there.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

// Fable 5.1's pi-ai thinkingLevelMap: only xhigh/max named, off unsupported.
const fable = {
	id: "claude-fable-5-1", name: "Claude Fable 5.1", api: "claude-bridge", provider: "claude-bridge",
	reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
	thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
};
const unmapped = { ...fable, id: "claude-test-unmapped", thinkingLevelMap: undefined };

const context = {
	systemPrompt: "You are an advisor.",
	messages: [{ role: "user", content: [{ type: "text", text: "Advise." }], timestamp: 0 }],
};

function captureQuery(captured) {
	return ({ options }) => {
		captured.push(options);
		async function* gen() {
			yield { type: "result", subtype: "success", is_error: false, result: "advice" };
		}
		const q = gen();
		q.interrupt = async () => {};
		q.close = () => {};
		return q;
	};
}

async function runIsolated(model, options) {
	const captured = [];
	__test.setQuery(captureQuery(captured));
	const result = await __test.isolatedStreamFn(model, context, { cacheRetention: "none", ...options }).result();
	assert.strictEqual(result.stopReason, "stop");
	assert.strictEqual(captured.length, 1);
	return captured[0];
}

afterEach(() => __test.setQuery(null));

describe("effortForReasoning", () => {
	it("uses the model's thinkingLevelMap when it names the level", () => {
		assert.strictEqual(__test.effortForReasoning(fable, "max"), "max");
		assert.strictEqual(__test.effortForReasoning(fable, "xhigh"), "xhigh");
	});

	it("falls back to the generic table for levels the map leaves unnamed", () => {
		assert.strictEqual(__test.effortForReasoning(fable, "high"), "high");
		assert.strictEqual(__test.effortForReasoning(unmapped, "xhigh"), "max");
	});

	it("sends no effort for unsupported or absent levels", () => {
		assert.strictEqual(__test.effortForReasoning(fable, "off"), undefined);
		assert.strictEqual(__test.effortForReasoning(fable, undefined), undefined);
	});
});

describe("isolated path effort", () => {
	it("passes the caller's reasoning level to Claude Code", async () => {
		const options = await runIsolated(fable, { reasoning: "max" });
		assert.strictEqual(options.effort, "max");
	});

	it("leaves effort to Claude Code's default without a reasoning level", async () => {
		const options = await runIsolated(fable, {});
		assert.ok(!("effort" in options));
	});
});
