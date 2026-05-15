/**
 * Tests for MODELS construction + resolveModelId + variant helpers.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * adaptive-thinking base models stay real IDs, optional `-instant` variants are virtual,
 * projection strips pi-ai's baseUrl/api/provider/headers, ordering preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, REAL_MODEL_IDS_IN_ORDER, buildModels, projectConfiguredModels, resolveModelId, baseModelId, thinkingModeFor, effortFor } from "../src/models.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

const PI_AI_BASE_IDS = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering and includes instant variants by default", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("can disable instant variants", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel), { instantVariants: false });
		assert.deepEqual(models.map((m) => m.id), REAL_MODEL_IDS_IN_ORDER);
		assert.equal(models.find((m) => m.id.endsWith("-instant")), undefined);
	});

	it("adaptive base models use real IDs; only instant entries are virtual", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		assert.ok(models.find((m) => m.id === "claude-opus-4-7"));
		assert.ok(models.find((m) => m.id === "claude-opus-4-7-instant"));
		assert.ok(models.find((m) => m.id === "claude-sonnet-4-6"));
		assert.ok(models.find((m) => m.id === "claude-sonnet-4-6-instant"));
		assert.equal(models.find((m) => m.id.endsWith("-thinking")), undefined);
	});

	it("opus 4.7 default map is label-accurate (max requires config override)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		for (const id of ["claude-opus-4-7", "claude-opus-4-7-instant"]) {
			const m = models.find((mm) => mm.id === id);
			assert.equal("off" in m.thinkingLevelMap, false);
			assert.equal(m.thinkingLevelMap.minimal, null);
			assert.equal(m.thinkingLevelMap.low, "low");
			assert.equal(m.thinkingLevelMap.medium, "medium");
			assert.equal(m.thinkingLevelMap.high, "high");
			assert.equal(m.thinkingLevelMap.xhigh, "xhigh");
		}
	});

	it("opus 4.6 and sonnet 4.6 default maps use natural labels, with xhigh selecting max", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		for (const id of ["claude-opus-4-6", "claude-opus-4-6-instant", "claude-sonnet-4-6", "claude-sonnet-4-6-instant"]) {
			const m = models.find((mm) => mm.id === id);
			assert.equal("off" in m.thinkingLevelMap, false);
			assert.equal(m.thinkingLevelMap.minimal, null);
			assert.equal(m.thinkingLevelMap.low, "low");
			assert.equal(m.thinkingLevelMap.medium, "medium");
			assert.equal(m.thinkingLevelMap.high, "high");
			assert.equal(m.thinkingLevelMap.xhigh, "max");
		}
	});

	it("haiku stays non-adaptive — no thinkingLevelMap", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		const haiku = models.find((m) => m.id === "claude-haiku-4-5");
		assert.equal(haiku.thinkingLevelMap, undefined);
	});

	it("haiku stays single-variant (not adaptive-thinking)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		const haikuVariants = models.filter((m) => m.id.includes("haiku"));
		assert.equal(haikuVariants.length, 1);
		assert.equal(haikuVariants[0].id, "claude-haiku-4-5");
	});

	it("instant variants get distinguishing name suffix; real models keep names", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		const thinking = models.find((m) => m.id === "claude-opus-4-7");
		const instant = models.find((m) => m.id === "claude-opus-4-7-instant");
		assert.equal(thinking.name, "claude-opus-4-7");
		assert.match(instant.name, /\(instant\)$/);
		const haiku = models.find((m) => m.id === "claude-haiku-4-5");
		assert.equal(haiku.name, "claude-haiku-4-5");
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("projectConfiguredModels preserves explicit thinkingLevelMap per duplicated model entry", () => {
		const shifted = { off: null, minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" };
		const labelAccurate = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
		const models = projectConfiguredModels([
			{ ...mockPiAiModel("claude-opus-4-7"), thinkingLevelMap: shifted },
			{ ...mockPiAiModel("claude-opus-4-7-instant"), thinkingLevelMap: labelAccurate },
		]);
		assert.deepEqual(models.find((m) => m.id === "claude-opus-4-7").thinkingLevelMap, shifted);
		assert.deepEqual(models.find((m) => m.id === "claude-opus-4-7-instant").thinkingLevelMap, labelAccurate);
	});
});

describe("resolveModelId", () => {
	const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-7 (first in order)", () => {
		assert.equal(resolveModelId(models, "opus"), "claude-opus-4-7");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModelId(models, "haiku"), "claude-haiku-4-5");
	});

	it("full IDs pass through unchanged", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-6-instant"), "claude-opus-4-6-instant");
		assert.equal(resolveModelId(models, "claude-opus-4-6"), "claude-opus-4-6");
	});

	it("old -thinking IDs no longer resolve after intentional config break", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-7-thinking"), "claude-opus-4-7-thinking");
	});

	it("falls through to input when no match", () => {
		assert.equal(resolveModelId(models, "gpt-9"), "gpt-9");
	});
});

describe("effortFor", () => {
	it("Opus 4.7: default mapping is label-accurate", () => {
		assert.equal(effortFor("claude-opus-4-7", "minimal"), undefined);
		assert.equal(effortFor("claude-opus-4-7", "low"), "low");
		assert.equal(effortFor("claude-opus-4-7", "medium"), "medium");
		assert.equal(effortFor("claude-opus-4-7", "high"), "high");
		assert.equal(effortFor("claude-opus-4-7", "xhigh"), "xhigh");
	});
	it("Opus 4.6: natural labels, xhigh selects max", () => {
		assert.equal(effortFor("claude-opus-4-6", "xhigh"), "max");
		assert.equal(effortFor("claude-opus-4-6", "minimal"), undefined);
	});
	it("Sonnet 4.6: natural label-aligned mapping (no xhigh tier)", () => {
		assert.equal(effortFor("claude-sonnet-4-6-instant", "low"), "low");
		assert.equal(effortFor("claude-sonnet-4-6-instant", "medium"), "medium");
		assert.equal(effortFor("claude-sonnet-4-6-instant", "high"), "high");
		assert.equal(effortFor("claude-sonnet-4-6-instant", "xhigh"), "max");
		assert.equal(effortFor("claude-sonnet-4-6-instant", "minimal"), undefined);
	});
	it("off → undefined (no effort flag)", () => {
		assert.equal(effortFor("claude-opus-4-7-instant", "off"), undefined);
		assert.equal(effortFor("claude-sonnet-4-6-instant", "off"), undefined);
	});
});

describe("baseModelId / thinkingModeFor", () => {
	it("baseModelId strips -instant suffix only", () => {
		assert.equal(baseModelId("claude-opus-4-7-instant"), "claude-opus-4-7");
		assert.equal(baseModelId("claude-opus-4-7"), "claude-opus-4-7");
		assert.equal(baseModelId("claude-haiku-4-5"), "claude-haiku-4-5");
	});

	it("thinkingModeFor returns on/off/undefined per variant kind", () => {
		assert.equal(thinkingModeFor("claude-opus-4-7"), "on");
		assert.equal(thinkingModeFor("claude-opus-4-7-instant"), "off");
		assert.equal(thinkingModeFor("claude-sonnet-4-6-instant"), "off");
		assert.equal(thinkingModeFor("claude-haiku-4-5"), undefined);
		assert.equal(thinkingModeFor("unknown-model"), undefined);
	});
});
