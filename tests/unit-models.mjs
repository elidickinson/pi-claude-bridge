/**
 * Tests for MODELS construction.
 * Pins: catalog-driven picker excludes pi-ai's dated snapshot aliases, projection strips
 * pi-ai's baseUrl/api/provider/headers, and the runtime policy gates [1m] ids
 * on measurement and plan settings.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLongContext, buildModels, extraUsageByChoice, resolveClaudeCodeRuntimeModel } from "../src/models.js";
import { getModels } from "@earendil-works/pi-ai/compat";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id, extra = {}) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
	...extra,
});

const oneM = (id) => mockPiAiModel(id, { contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("driven by pi-ai's real anthropic catalog, minus dated snapshot aliases", () => {
		const models = buildModels(getModels("anthropic"));
		for (const m of models) {
			assert.doesNotMatch(m.id, /-20\d{6}$/, "no dated snapshot ids in the picker");
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			// With a cache lifetime, pi's cache warmer would replay requests through the bridge.
			assert.equal(m.promptCache, undefined);
		}
		// Spot-check coverage of every current family.
		assert.ok(find(models, "claude-opus-5"), "opus-5 present");
		assert.ok(find(models, "claude-fable-5-1"), "fable-5-1 present");
		assert.ok(find(models, "claude-haiku-4-5"), "haiku present");
	});

	it("sorts newest generation first within each family", () => {
		const models = buildModels([
			oneM("claude-opus-4-7"), oneM("claude-opus-5"),
			oneM("claude-sonnet-5"), oneM("claude-opus-4-6"),
		]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"]);
	});

	it("drops dated aliases in favor of bare ids", () => {
		const models = buildModels([mockPiAiModel("claude-opus-4-5-20251101"), mockPiAiModel("claude-opus-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-5"]);
	});

	it("sinks unknown families below the known shortcut families", () => {
		const models = buildModels([oneM("claude-proxy-x"), oneM("claude-opus-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-proxy-x"]);
	});

	it("forwards pi-ai's thinkingLevelMap verbatim", () => {
		const withMap = () => mockPiAiModel("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const models = buildModels([withMap(), mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		assert.equal(find(models, "claude-haiku-4-5")?.thinkingLevelMap, undefined, "no fabricated default");
	});
});

describe("Claude Code runtime policy", () => {
	it("measured-1M ids send [1m] on every plan", () => {
		for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
			assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM(id), PRO), { cliModelId: `${id}[1m]`, contextWindow: 1000000 });
		}
	});

	it("unmeasured ids serve bare at 200K even when pi-ai declares 1M (sonnet-4-5)", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-5"), PRO), { cliModelId: "claude-sonnet-4-5", contextWindow: 200000 });
	});

	it("declared 200K maps to bare id", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-haiku-4-5"), PRO), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("measured exception: opus-4-6 1M is plan-gated", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), PRO), { cliModelId: "claude-opus-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), MAX), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), EXTRA), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
	});

	it("measured exception: sonnet-4-6 1M requires extra usage", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), PRO), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), EXTRA), { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1000000 });
	});

	it("extraUsageByChoice: only 1M that longContextExtraUsage turned on", () => {
		assert.equal(extraUsageByChoice({ id: "claude-sonnet-4-6" }, EXTRA), true);
		assert.equal(extraUsageByChoice({ id: "claude-opus-4-6" }, EXTRA), true);
		assert.equal(extraUsageByChoice({ id: "claude-opus-4-6" }, { ...MAX, longContextExtraUsage: true }), false, "Max serves it from the plan");
		assert.equal(extraUsageByChoice({ id: "claude-sonnet-4-6" }, PRO), false);
		assert.equal(extraUsageByChoice({ id: "claude-sonnet-4-6" }, { ...EXTRA, forceTwoHundredK: ["claude-sonnet-4-6"] }), false);
		assert.equal(extraUsageByChoice({ id: "claude-opus-5" }, EXTRA), false);
	});

	it("forceTwoHundredK overrides an optimistic 1M declaration", () => {
		assert.deepEqual(
			resolveClaudeCodeRuntimeModel(oneM("claude-future-9"), { ...PRO, forceTwoHundredK: ["claude-future-9"] }),
			{ cliModelId: "claude-future-9", contextWindow: 200000 },
		);
	});

	it("unknown model falls back to bare id at 200K", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-future-9-9"), PRO), { cliModelId: "claude-future-9-9", contextWindow: 200000 });
	});
});

describe("applyLongContext", () => {
	const models = buildModels(getModels("anthropic"));

	it("registers 1M for measured-1M models", () => {
		const registered = applyLongContext(models, PRO);
		assert.equal(find(registered, "claude-opus-5").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-7").contextWindow, 1000000);
		assert.equal(find(registered, "claude-fable-5-1").contextWindow, 1000000);
	});

	it("leaves unmeasured sonnet-4-5 at 200K", () => {
		assert.equal(find(applyLongContext(models, PRO), "claude-sonnet-4-5").contextWindow, 200000);
	});

	it("plan gates only the measured exceptions", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-4-6").contextWindow, 200000);
		assert.equal(find(pro, "claude-sonnet-4-6").contextWindow, 200000);

		const max = applyLongContext(models, MAX);
		assert.equal(find(max, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(max, "claude-sonnet-4-6").contextWindow, 200000);

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(extra, "claude-sonnet-4-6").contextWindow, 1000000);

		// Does not mutate the source table used for id resolution.
		assert.equal(find(models, "claude-opus-4-6").contextWindow, 1000000);
	});

	it("labels exactly the registered 1M models", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-5").name, "Claude Opus 5 1M");
		assert.equal(find(pro, "claude-opus-4-6").name, "Claude Opus 4.6");
		assert.equal(find(pro, "claude-haiku-4-5").name, "Claude Haiku 4.5 (latest)");

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-sonnet-4-6").name, "Claude Sonnet 4.6 1M");
	});
});
