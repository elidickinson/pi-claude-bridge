/**
 * Tests for updateUsage in src/usage.ts.
 * Pins: reasoning is read only from the nested output_tokens_details.thinking_tokens
 * shape, never from a flat thinking_tokens or a reasoning_tokens field; reasoning
 * tokens stay out of totalTokens (they are a subset of output_tokens); cachePct
 * divides by zero-safe prompt tokens; and a partial usage frame only overwrites
 * the counters it actually carries.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updateUsage } from "../src/usage.js";

const model = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// pi-ai bills per million tokens, so a rate of 1_000_000 makes one token cost exactly 1
// and keeps the expected totals below readable.
const pricedModel = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
};

const emptyOutput = () => ({
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

describe("updateUsage", () => {
	it("reads the nested thinking count onto usage.reasoning", () => {
		const output = emptyOutput();
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		assert.equal(output.usage.reasoning, 40);
	});

	it("ignores a flat thinking_tokens, which no SDK version emits", () => {
		const output = emptyOutput();
		// This is the exact shape the old code read; reading it would mean the nesting contract was misunderstood again.
		updateUsage(output, { output_tokens: 100, thinking_tokens: 40 }, model);
		assert.equal(output.usage.reasoning, undefined);
	});

	it("ignores reasoning_tokens, a field that exists in no SDK version", () => {
		const output = emptyOutput();
		updateUsage(output, { output_tokens: 100, reasoning_tokens: 40 }, model);
		assert.equal(output.usage.reasoning, undefined);
	});

	it("leaves reasoning untouched when the frame carries no details", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 20 }, model);
		assert.equal(output.usage.reasoning, undefined);
	});

	it("maps the four flat counters", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, model);
		assert.equal(output.usage.input, 10);
		assert.equal(output.usage.output, 20);
		assert.equal(output.usage.cacheRead, 30);
		assert.equal(output.usage.cacheWrite, 40);
		assert.equal(output.usage.totalTokens, 100);
	});

	it("keeps reasoning out of the token total", () => {
		const output = emptyOutput();
		// Thinking tokens are a subset of output_tokens, not additional tokens.
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		assert.equal(output.usage.totalTokens, 100);
	});

	it("reports the cache share of the prompt", () => {
		const output = emptyOutput();
		const report = updateUsage(output, { input_tokens: 25, cache_read_input_tokens: 75 }, model);
		assert.equal(report.cachePct, 75);
	});

	it("reports zero cache share when there is no prompt", () => {
		const output = emptyOutput();
		const report = updateUsage(output, { output_tokens: 10 }, model);
		assert.equal(report.cachePct, 0);
	});

	it("only overwrites counters the frame actually carries", () => {
		const output = emptyOutput();
		output.usage.input = 5;
		// The three call sites read different subsets of the usage shape, so a partial frame must not zero the others.
		updateUsage(output, { output_tokens: 7 }, model);
		assert.equal(output.usage.input, 5);
	});

	it("bills the counters and never the reasoning tokens", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, pricedModel);

		// 10 input at 1 plus 100 output at 2. Folding the 40 reasoning tokens into output
		// would bill 290 instead, which is the regression a zero-rate model cannot catch.
		assert.equal(output.usage.cost.total, 210);
	});

	it("reports the thinking count carried by this frame", () => {
		const output = emptyOutput();
		const report = updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);

		assert.equal(report.reasoning, 40);
	});

	it("omits reasoning for a frame that carries none, even after one that did", () => {
		const output = emptyOutput();
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		const report = updateUsage(output, { output_tokens: 120 }, model);

		// output.usage.reasoning deliberately keeps the earlier 40; the report must not,
		// or the debug line reprints a stale count on every later frame.
		assert.equal(report.reasoning, undefined);
		assert.equal(output.usage.reasoning, 40);
	});
});
