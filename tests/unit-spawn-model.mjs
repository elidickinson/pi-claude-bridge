/**
 * What each Claude Code spawn site actually sends for a 200K twin and its base.
 * unit-models.mjs pins the runtime policy; this pins that the provider,
 * compact-summary and AskClaude paths all apply it: a twin must reach CC as the
 * bare id with CLAUDE_CODE_DISABLE_1M_CONTEXT=1 (the bare id alone serves 1M on
 * Opus 5.5), and its base as the [1m] id without that variable.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

const TWIN = { cliModel: "claude-opus-5-5", disable1M: "1" };
const BASE = { cliModel: "claude-opus-5-5[1m]", disable1M: undefined };

let calls = [];

// Stands in for the SDK's query(): records its options and yields one successful
// result so every consumer runs to completion without a subprocess.
function fakeQuery({ options }) {
	calls.push(options);
	const messages = [{
		type: "result", subtype: "success", is_error: false, result: "summary text",
		usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		modelUsage: {},
	}];
	return {
		async *[Symbol.asyncIterator]() { yield* messages; },
		interrupt: async () => {},
		close: () => {},
	};
}

function spawned() {
	assert.equal(calls.length, 1, `expected one query() call, got ${calls.length}`);
	const options = calls[0];
	// The provider path passes the model through extraArgs; the others through options.model.
	const cliModel = options.model ?? options.extraArgs?.model;
	return { cliModel, disable1M: options.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT };
}

const piModel = (id, contextWindow) => ({ id, name: id, api: "claude-bridge", provider: "claude-bridge", contextWindow, maxTokens: 128000, reasoning: true });

async function drain(stream) {
	for await (const event of stream) if (event.type === "done" || event.type === "error") return event;
}

before(() => {
	// Activation computes the registered model list (twins included) that
	// AskClaude resolves against. registerTool is stubbed for the same reason as
	// in unit-branch-summary.mjs: a local config may enable AskClaude.
	activate({ on: () => {}, registerProvider: () => {}, registerTool: () => {} });
	__test.setQueryFn(fakeQuery);
});

after(() => {
	__test.setQueryFn(null);
	__test.resetSharedSession();
});

const cases = [
	["twin", "claude-200k-opus-5-5", 200000, TWIN],
	["base", "claude-opus-5-5", 1000000, BASE],
];

describe("provider spawn", () => {
	for (const [label, id, contextWindow, expected] of cases) {
		it(`${label} (${id})`, async () => {
			calls = [];
			__test.resetSharedSession();
			const stream = __test.streamClaudeAgentSdk(piModel(id, contextWindow), {
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			});
			assert.deepEqual(spawned(), expected);
			await drain(stream);
		});
	}
});

describe("compact-summary spawn", () => {
	for (const [label, id, contextWindow, expected] of cases) {
		it(`${label} (${id})`, async () => {
			calls = [];
			// cacheRetention "none" is how pi marks one-off summarizer calls; the
			// provider hands them to the isolated compact-summary path.
			const stream = __test.streamClaudeAgentSdk(piModel(id, contextWindow), {
				systemPrompt: "Summarize the conversation.",
				messages: [{ role: "user", content: "the transcript", timestamp: Date.now() }],
			}, { cacheRetention: "none" });
			const end = await drain(stream);
			assert.equal(end?.type, "done", `summary did not complete: ${JSON.stringify(end?.error?.errorMessage)}`);
			assert.deepEqual(spawned(), expected);
		});
	}
});

describe("AskClaude spawn", () => {
	for (const [label, id, , expected] of cases) {
		it(`${label} (${id})`, async () => {
			calls = [];
			await __test.promptAndWait("hi", "none", new Map(), undefined, { model: id, isolated: true, appendSkills: false });
			assert.deepEqual(spawned(), expected);
		});
	}
});
