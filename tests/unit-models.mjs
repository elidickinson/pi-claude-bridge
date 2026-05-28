/**
 * Tests for MODELS construction + resolveModelId.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, buildModels, resolveModelId } from "../src/models.js";

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

	it("drops IDs with no pi-ai entry and no synthetic base", () => {
		// Only haiku present — opus/sonnet vanish; opus-4-8's synthetic base
		// (opus-4-7) is also absent, so it can't be cloned either.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("synthesizes claude-opus-4-8 from claude-opus-4-7 when pi-ai lacks it", () => {
		// pi-ai has 4-7 but not 4-8 (current state): 4-8 is cloned from 4-7.
		const models = buildModels([mockPiAiModel("claude-opus-4-7")]);
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("claude-opus-4-8"));
		const v48 = models.find((m) => m.id === "claude-opus-4-8");
		const v47 = models.find((m) => m.id === "claude-opus-4-7");
		assert.equal(v48.name, "Claude Opus 4.8");
		assert.equal(v48.contextWindow, v47.contextWindow);
		assert.equal(v48.maxTokens, v47.maxTokens);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});
});

describe("resolveModelId", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-8 (first opus in order)", () => {
		assert.equal(resolveModelId(models, "opus"), "claude-opus-4-8");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModelId(models, "haiku"), "claude-haiku-4-5");
	});

	it("full ID passes through unchanged", () => {
		assert.equal(resolveModelId(models, "claude-opus-4-6"), "claude-opus-4-6");
	});

	it("falls through to input when no match", () => {
		assert.equal(resolveModelId(models, "gpt-9"), "gpt-9");
	});
});
