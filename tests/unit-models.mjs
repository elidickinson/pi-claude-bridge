/**
 * Tests for MODELS construction + resolveModel.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, applyLongContext, buildModels, claudeCodeModelId, isAdaptiveModel, resolveClaudeCodeRuntimeModel, resolveModel, resolveThinking } from "../src/models.js";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		// Only haiku present — opus/sonnet vanish from picker.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("leaves display names bare before plan-specific context is applied", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
		assert.ok(models.every((m) => !m.name.includes("1M")));
	});
});

describe("Claude Code runtime model policy", () => {
	it("uses measured Pro defaults", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-8", PRO), { cliModelId: "claude-opus-4-8[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-7", PRO), { cliModelId: "claude-opus-4-7", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO), { cliModelId: "claude-opus-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", PRO), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", PRO), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("plan max only changes Opus 4.6", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-8", MAX), { cliModelId: "claude-opus-4-8[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-7", MAX), { cliModelId: "claude-opus-4-7", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", MAX), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", MAX), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
	});

	it("longContextExtraUsage enables metered variants but not Haiku", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-opus-4-6", EXTRA), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", EXTRA), { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", EXTRA), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("unknown model falls back to bare id at 200K", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel("claude-future-9-9", PRO), { cliModelId: "claude-future-9-9", contextWindow: 200000 });
	});
});

describe("claudeCodeModelId", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("returns the measured SDK request id", () => {
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-8"), PRO), "claude-opus-4-8[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-7"), PRO), "claude-opus-4-7");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-6"), PRO), "claude-opus-4-6");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-6"), MAX), "claude-opus-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-sonnet-4-6"), EXTRA), "claude-sonnet-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-haiku-4-5"), EXTRA), "claude-haiku-4-5");
	});

});

describe("applyLongContext", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("registers measured Pro defaults", () => {
		const registered = applyLongContext(models, PRO);
		assert.equal(find(registered, "claude-opus-4-8").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-7").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 200000);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 200000);
		assert.equal(find(registered, "claude-haiku-4-5").contextWindow, 200000);
		// Does not mutate the source table used for id resolution.
		assert.equal(find(models, "claude-opus-4-6").contextWindow, 1000000);
	});

	it("registers Max-plan Opus 4.6 at 1M but leaves Sonnet at 200K", () => {
		const registered = applyLongContext(models, MAX);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 200000);
	});

	it("registers extra-usage Opus 4.6 and Sonnet at 1M", () => {
		const registered = applyLongContext(models, EXTRA);
		assert.equal(find(registered, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-sonnet-4-6").contextWindow, 1000000);
		assert.equal(find(registered, "claude-haiku-4-5").contextWindow, 200000);
	});

	it("labels exactly the registered 1M models", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-4-8").name, "claude-opus-4-8 1M");
		assert.equal(find(pro, "claude-opus-4-7").name, "claude-opus-4-7 1M");
		assert.equal(find(pro, "claude-opus-4-6").name, "claude-opus-4-6");
		assert.equal(find(pro, "claude-sonnet-4-6").name, "claude-sonnet-4-6");

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-opus-4-6").name, "claude-opus-4-6 1M");
		assert.equal(find(extra, "claude-sonnet-4-6").name, "claude-sonnet-4-6 1M");
	});
});

describe("resolveModel", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-8 (first opus in order)", () => {
		assert.equal(resolveModel(models, "opus")?.id, "claude-opus-4-8");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-4-5");
	});

	it("full ID resolves to itself", () => {
		assert.equal(resolveModel(models, "claude-opus-4-6")?.id, "claude-opus-4-6");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});

	it("returns the matched model object for CLI-arg conversion", () => {
		const oneMModels = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		const model = resolveModel(oneMModels, "opus");
		assert.equal(model.id, "claude-opus-4-8");
		assert.equal(claudeCodeModelId(model, PRO), "claude-opus-4-8[1m]");
	});
});

describe("isAdaptiveModel", () => {
	it("every bridge model except Haiku is adaptive", () => {
		for (const id of MODEL_IDS_IN_ORDER) {
			assert.equal(isAdaptiveModel(id), id !== "claude-haiku-4-5", id);
		}
	});

	it("unknown ids are not adaptive (arbitrary AskClaude model params)", () => {
		assert.equal(isAdaptiveModel("gpt-9"), false);
		assert.equal(isAdaptiveModel("claude-opus-4-7-20251115"), false);
	});
});

describe("resolveThinking", () => {
	const r = (modelId, reasoning, map) => resolveThinking(modelId, reasoning, "high", map);
	const ADAPTIVE_ON = { type: "adaptive", display: "summarized" };

	it("adaptive + undefined (pi slider off) → thinking disabled with effortWhenOff", () => {
		assert.deepEqual(r("claude-opus-4-7", undefined), { effort: "high", thinking: { type: "disabled" } });
	});

	it('adaptive + literal "off" (AskClaude) → same as undefined', () => {
		assert.deepEqual(r("claude-sonnet-5", "off"), { effort: "high", thinking: { type: "disabled" } });
	});

	it("respects a custom effortWhenOff", () => {
		assert.deepEqual(resolveThinking("claude-opus-4-7", "off", "max"), { effort: "max", thinking: { type: "disabled" } });
	});

	it("off unsupported per pi-ai map (fable-5) → clamps to minimal, thinking stays adaptive", () => {
		assert.deepEqual(r("claude-fable-5", "off", { off: null, xhigh: "xhigh" }), { effort: "low", thinking: ADAPTIVE_ON });
	});

	it("xhigh prefers the model thinkingLevelMap (opus-4-7 → xhigh, opus-4-6 → max)", () => {
		assert.deepEqual(r("claude-opus-4-7", "xhigh", { xhigh: "xhigh" }), { effort: "xhigh", thinking: ADAPTIVE_ON });
		assert.deepEqual(r("claude-opus-4-6", "xhigh", { xhigh: "max" }), { effort: "max", thinking: ADAPTIVE_ON });
	});

	it("xhigh with no map falls back to the table (sonnet-4-6 → max)", () => {
		assert.deepEqual(r("claude-sonnet-4-6", "xhigh"), { effort: "max", thinking: ADAPTIVE_ON });
	});

	it("minimal/low/medium/high fall through to the table, thinking explicitly adaptive", () => {
		assert.deepEqual(r("claude-opus-4-7", "minimal"), { effort: "low", thinking: ADAPTIVE_ON });
		assert.deepEqual(r("claude-opus-4-7", "high"), { effort: "high", thinking: ADAPTIVE_ON });
	});

	it("haiku keeps legacy behavior: level → table effort, off/undefined → nothing", () => {
		assert.deepEqual(r("claude-haiku-4-5", "high"), { effort: "high" });
		assert.deepEqual(r("claude-haiku-4-5", "off"), {});
		assert.deepEqual(r("claude-haiku-4-5", undefined), {});
	});

	it("unknown model → legacy behavior, never sends a thinking flag", () => {
		assert.deepEqual(r("gpt-9", "off"), {});
		assert.deepEqual(r("gpt-9", "high"), { effort: "high" });
	});
});
