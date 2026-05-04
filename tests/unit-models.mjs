/**
 * Tests for MODELS construction + resolveModelId + variant helpers.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * adaptive-thinking models split into `-thinking` + bare variants,
 * projection strips pi-ai's baseUrl/api/provider/headers, ordering preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, buildModels, resolveModelId, baseModelId, thinkingModeFor, effortFor } from "../src/models.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

// pi-ai entries are keyed by base model IDs (no `-thinking` suffix).
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

	it("preserves MODEL_IDS_IN_ORDER ordering and includes both variants for adaptive models", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("adaptive models produce two variants per base ID (-thinking / -instant)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		assert.ok(models.find((m) => m.id === "claude-opus-4-7-instant"));
		assert.ok(models.find((m) => m.id === "claude-opus-4-7-thinking"));
		assert.ok(models.find((m) => m.id === "claude-sonnet-4-6-instant"));
		assert.ok(models.find((m) => m.id === "claude-sonnet-4-6-thinking"));
		// No bare adaptive ID — the suffix is required.
		assert.equal(models.find((m) => m.id === "claude-opus-4-7"), undefined);
		assert.equal(models.find((m) => m.id === "claude-sonnet-4-6"), undefined);
	});

	it("opus 4.6/4.7 variants use 5-slot shift (minimal..xhigh → low..max)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		for (const id of [
			"claude-opus-4-7-thinking", "claude-opus-4-7-instant",
			"claude-opus-4-6-thinking", "claude-opus-4-6-instant",
		]) {
			const m = models.find((mm) => mm.id === id);
			assert.equal(m.thinkingLevelMap.off, null);
			assert.equal(m.thinkingLevelMap.minimal, "low");
			assert.equal(m.thinkingLevelMap.low, "medium");
			assert.equal(m.thinkingLevelMap.medium, "high");
			assert.equal(m.thinkingLevelMap.high, "xhigh");
			assert.equal(m.thinkingLevelMap.xhigh, "max");
		}
	});

	it("sonnet 4.6 variants use natural 4-slot mapping (no xhigh tier on sonnet)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		const m = models.find((mm) => mm.id === "claude-sonnet-4-6-thinking");
		assert.equal(m.thinkingLevelMap.off, null);
		assert.equal(m.thinkingLevelMap.minimal, null);
		assert.equal(m.thinkingLevelMap.low, "low");
		assert.equal(m.thinkingLevelMap.medium, "medium");
		assert.equal(m.thinkingLevelMap.high, "high");
		assert.equal(m.thinkingLevelMap.xhigh, "max");
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

	it("variants get distinguishing name suffixes (thinking / instant)", () => {
		const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));
		const thinking = models.find((m) => m.id === "claude-opus-4-7-thinking");
		const instant = models.find((m) => m.id === "claude-opus-4-7-instant");
		assert.match(thinking.name, /\(thinking\)$/);
		assert.match(instant.name, /\(instant\)$/);
		// Haiku (non-adaptive) keeps the unmodified name.
		const haiku = models.find((m) => m.id === "claude-haiku-4-5");
		assert.equal(haiku.name, "claude-haiku-4-5");
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		// Only haiku present — opus/sonnet variants vanish from picker.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});
});

describe("resolveModelId", () => {
	const models = buildModels(PI_AI_BASE_IDS.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-7-thinking (first in order)", () => {
		assert.equal(resolveModelId(models, "opus"), "claude-opus-4-7-thinking");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModelId(models, "haiku"), "claude-haiku-4-5");
	});

	it("full variant ID passes through unchanged", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-6-instant"), "claude-opus-4-6-instant");
		assert.equal(resolveModelId(models, "claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
	});

	it("bare adaptive ID resolves to the -thinking variant (first by substring)", () => {
		// Real Anthropic ID `claude-opus-4-7` is no longer a slug; it substring-matches
		// `claude-opus-4-7-thinking` first. AskClaude callers passing the bare ID get the
		// thinking variant, matching opus-shortcut behavior. Use `-instant` explicitly otherwise.
		assert.equal(resolveModelId(models, "claude-opus-4-7"), "claude-opus-4-7-thinking");
	});

	it("falls through to input when no match", () => {
		assert.equal(resolveModelId(models, "gpt-9"), "gpt-9");
	});
});

describe("effortFor", () => {
	it("Opus 4.7: shifted mapping exposes all 5 effort tiers", () => {
		assert.equal(effortFor("claude-opus-4-7-instant", "minimal"), "low");
		assert.equal(effortFor("claude-opus-4-7-instant", "low"), "medium");
		assert.equal(effortFor("claude-opus-4-7-instant", "medium"), "high");
		assert.equal(effortFor("claude-opus-4-7-instant", "high"), "xhigh");
		assert.equal(effortFor("claude-opus-4-7-instant", "xhigh"), "max");
	});
	it("Opus 4.6: same shifted mapping", () => {
		assert.equal(effortFor("claude-opus-4-6-thinking", "xhigh"), "max");
		assert.equal(effortFor("claude-opus-4-6-thinking", "minimal"), "low");
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
	it("baseModelId strips -thinking suffix", () => {
		assert.equal(baseModelId("claude-opus-4-7-thinking"), "claude-opus-4-7");
		assert.equal(baseModelId("claude-opus-4-7"), "claude-opus-4-7");
		assert.equal(baseModelId("claude-haiku-4-5"), "claude-haiku-4-5");
	});

	it("thinkingModeFor returns on/off/undefined per variant kind", () => {
		assert.equal(thinkingModeFor("claude-opus-4-7-thinking"), "on");
		assert.equal(thinkingModeFor("claude-opus-4-7-instant"), "off");
		assert.equal(thinkingModeFor("claude-sonnet-4-6-instant"), "off");
		assert.equal(thinkingModeFor("claude-haiku-4-5"), undefined);
		assert.equal(thinkingModeFor("unknown-model"), undefined);
	});
});
