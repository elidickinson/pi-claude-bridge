/**
 * Tests for MODELS construction + resolveModel.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, buildModels, claudeCodeModelId, resolveModel, applyLongContext } from "../src/models.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

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

	it("keeps display names bare regardless of context window", () => {
		// 1M is opt-in per model via provider.enableLongContextModels, so the static
		// picker name never advertises it.
		const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
		const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
		assert.ok(models.every((m) => !m.name.includes("[1m]")));
	});
});

describe("claudeCodeModelId", () => {
	const oneMModel = { id: "claude-opus-4-8", contextWindow: 1000000 };
	const twoHundredKModel = { id: "claude-haiku-4-5", contextWindow: 200000 };

	it("appends [1m] only when opted in AND 1M-capable", () => {
		assert.equal(claudeCodeModelId(oneMModel, true), "claude-opus-4-8[1m]");
	});

	it("stays bare when capable but not opted in (default)", () => {
		assert.equal(claudeCodeModelId(oneMModel, false), "claude-opus-4-8");
	});

	it("stays bare when opted in but only 200K-capable (Haiku)", () => {
		assert.equal(claudeCodeModelId(twoHundredKModel, true), "claude-haiku-4-5");
	});

	it("does not double-suffix an id that already contains [1m]", () => {
		assert.equal(claudeCodeModelId({ id: "claude-opus-4-8[1m]", contextWindow: 1000000 }, true), "claude-opus-4-8[1m]");
	});
});

describe("applyLongContext (registered contextWindow)", () => {
	const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("plan pro (default): caps unlisted long-context models to 200K", () => {
		const registered = applyLongContext(models, new Set(), "pro");
		for (const m of registered) {
			assert.equal(m.contextWindow, 200000, `${m.id} should register at 200K`);
		}
		// Does not mutate the source table used for id resolution.
		assert.equal(models.find((m) => m.id === "claude-opus-4-8").contextWindow, 1000000);
	});

	it("keeps 1M for opted-in long-context models (matches the [1m] CLI id)", () => {
		const registered = applyLongContext(models, new Set(["claude-opus-4-8", "claude-sonnet-4-6"]), "pro");
		assert.equal(registered.find((m) => m.id === "claude-opus-4-8").contextWindow, 1000000);
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").contextWindow, 1000000);
		// Unlisted long-context siblings stay capped.
		assert.equal(registered.find((m) => m.id === "claude-opus-4-7").contextWindow, 200000);
	});

	it("plan max: registers unlisted Opus at 1M (CC auto-upgrades bare id, no [1m])", () => {
		const registered = applyLongContext(models, new Set(), "max");
		for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
			assert.equal(registered.find((m) => m.id === id).contextWindow, 1000000, `${id} should register at 1M on max`);
		}
	});

	it("plan max: Sonnet still caps at 200K (no auto-upgrade, needs explicit [1m])", () => {
		const registered = applyLongContext(models, new Set(), "max");
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").contextWindow, 200000);
	});

	it("plan max does not append [1m] (decoupled from enableLongContextModels, avoids #39841)", () => {
		// Unlisted Opus on max registers 1M but the CLI id stays bare — only
		// enableLongContextModels membership drives the [1m] suffix, never plan.
		const opus = applyLongContext(models, new Set(), "max").find((m) => m.id === "claude-opus-4-8");
		assert.equal(claudeCodeModelId(opus, false), "claude-opus-4-8");
	});

	it("leaves Haiku (200K native) at 200K whether listed or not", () => {
		const bare200K = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel)); // haiku=200K
		assert.equal(applyLongContext(bare200K, new Set(["claude-haiku-4-5"]), "max").find((m) => m.id === "claude-haiku-4-5").contextWindow, 200000);
		assert.equal(applyLongContext(bare200K, new Set(), "pro").find((m) => m.id === "claude-haiku-4-5").contextWindow, 200000);
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
		const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
		const oneMModels = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		const model = resolveModel(oneMModels, "opus");
		assert.equal(model.id, "claude-opus-4-8");
		// Opted in → [1m] applied at the CLI boundary.
		assert.equal(claudeCodeModelId(model, true), "claude-opus-4-8[1m]");
		// Default (not opted in) → bare.
		assert.equal(claudeCodeModelId(model, false), "claude-opus-4-8");
	});
});
