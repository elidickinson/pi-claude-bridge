// Canonical selection + display order for the model picker.
// `resolveModelId` returns exact match first, else first partial match (substring),
// so `opus` resolves to the first-listed opus entry.
//
// Adaptive-thinking models (Opus 4.6/4.7, Sonnet 4.6) use the real pi-ai model
// IDs as the thinking-visible entries. Optional `-instant` virtual variants are
// added for users who want Claude Code's adaptive thinking disabled while still
// selecting an effort level via pi's reasoning knob.
//
// Haiku 4.5 is NOT adaptive-thinking (uses budget-based thinking, no effort knob),
// so it stays single-variant with no suffix; reasoning controls thinking on/off
// there as before.

const ADAPTIVE_THINKING_BASE_IDS = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"] as const;
const ADAPTIVE_THINKING_BASE_ID_SET = new Set<string>(ADAPTIVE_THINKING_BASE_IDS);

export const REAL_MODEL_IDS_IN_ORDER = [
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
] as const;

export const MODEL_IDS_IN_ORDER = [
	"claude-opus-4-7", "claude-opus-4-7-instant",
	"claude-opus-4-6", "claude-opus-4-6-instant",
	"claude-sonnet-4-6", "claude-sonnet-4-6-instant",
	"claude-haiku-4-5",
] as const;

export type ThinkingLevelMap = Record<string, string | null>;

export interface BuildModelsOptions {
	/** Include `-instant` virtual variants for adaptive-thinking models. Defaults true. */
	instantVariants?: boolean;
}

/** Strip `-instant` suffix to get the real Anthropic model ID for the CC binary. */
export function baseModelId(variantId: string): string {
	return variantId.endsWith("-instant") ? variantId.slice(0, -"-instant".length) : variantId;
}

/**
 * "on"  — adaptive base model: force thinking blocks visible.
 * "off" — `-instant` variant: force thinking off (overrides settings.json).
 * undefined — non-adaptive model (haiku): preserve legacy behavior (reasoning gates thinking).
 */
export function thinkingModeFor(variantId: string): "on" | "off" | undefined {
	if (variantId.endsWith("-instant")) return "off";
	return ADAPTIVE_THINKING_BASE_ID_SET.has(variantId) ? "on" : undefined;
}

// Per-base-model thinkingLevelMap. Values do double duty:
//   - non-null = level appears in pi's selector
//   - null     = level hidden
//   - the string is also the literal effort value sent to the Anthropic API
//     (read by `effortFor()` below).
//
// Common rules across all adaptive Claude models:
//   - `off` hidden — effort-less adaptive requests can silently default high-ish.
//   - `minimal` hidden by default — Anthropic's effort enum has no minimal tier.
//   - Built-in defaults prefer label accuracy. Users who want to expose Opus 4.7
//     `max` through pi's missing max slot can define explicit claude-bridge
//     models in ~/.pi/agent/models.json with shifted thinkingLevelMap entries.
function defaultThinkingLevelMapFor(baseId: string): ThinkingLevelMap {
	if (baseId === "claude-opus-4-7") {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
	}
	if (baseId === "claude-opus-4-6" || baseId === "claude-sonnet-4-6") {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max" };
	}
	return { off: null, minimal: null, low: "low", medium: "medium", high: "high" };
}

/**
 * Resolve a pi reasoning level → Anthropic effort string for a given model variant.
 * Returns undefined for `off` / hidden / unmapped levels (no effort flag sent).
 */
export function thinkingLevelMapFor(baseId: string): ThinkingLevelMap {
	return defaultThinkingLevelMapFor(baseId);
}

export function effortFor(variantId: string, reasoning: string, map?: ThinkingLevelMap): string | undefined {
	map ??= thinkingLevelMapFor(baseModelId(variantId));
	const mapped = map[reasoning];
	if (mapped === null) return undefined;
	return mapped ?? undefined;
}

function projectModel<T extends { id: string; [key: string]: any }>(base: T, id: string, name: string, adaptive: boolean) {
	const { reasoning, input, contextWindow, maxTokens } = base;
	return {
		id,
		name,
		reasoning, input, contextWindow, maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(adaptive ? { thinkingLevelMap: base.thinkingLevelMap ?? thinkingLevelMapFor(base.id) } : {}),
	};
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep real model IDs for thinking-visible entries, optionally add `-instant`
// virtual variants, and preserve MODEL_IDS_IN_ORDER ordering. IDs missing from
// pi-ai are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[], options: BuildModelsOptions = {}) {
	const instantVariants = options.instantVariants !== false;
	const byId = new Map(piAiModels.map((m) => [m.id, m]));
	const ids = instantVariants ? MODEL_IDS_IN_ORDER : REAL_MODEL_IDS_IN_ORDER;
	return ids
		.map((id) => {
			const baseId = baseModelId(id);
			const base = byId.get(baseId);
			if (!base) return null;
			const adaptive = ADAPTIVE_THINKING_BASE_ID_SET.has(baseId);
			const baseName = base.name ?? base.id;
			const name = id.endsWith("-instant") ? `${baseName} (instant)` : baseName;
			return projectModel(base, id, name, adaptive);
		})
		.filter((m): m is NonNullable<typeof m> => m != null);
}

export function projectConfiguredModels<T extends { id: string; [key: string]: any }>(models: T[]) {
	return models.map((m) => {
		const baseId = baseModelId(m.id);
		const adaptive = ADAPTIVE_THINKING_BASE_ID_SET.has(baseId);
		const name = m.name ?? m.id;
		return projectModel(m, m.id, name, adaptive);
	});
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	const exact = models.find((m) => m.id === lower);
	if (exact) return exact.id;
	const partial = models.find((m) => m.id.includes(lower));
	return partial ? partial.id : input;
}
