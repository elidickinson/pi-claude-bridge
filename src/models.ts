// Canonical selection + display order for the model picker.
// `resolveModelId` returns exact match first, else first partial match (substring),
// so `opus` resolves to the first-listed opus entry.
//
// Adaptive-thinking models (Opus 4.6/4.7, Sonnet 4.6) are exposed as TWO variants
// each so users can pick "thinking visible" vs "thinking hidden" independently
// of the effort level (which is set via pi's reasoning knob). The `-thinking`
// variant is listed first so `opus`/`sonnet` shortcuts resolve to it — matching
// pre-variant behavior where any reasoning level implied thinking on.
//
// Both variants are suffixed (`-thinking` / `-instant`) so the model slug clearly
// communicates intent in the picker. `baseModelId()` strips either suffix to get
// the real Anthropic model ID for the CC binary.
//
// Haiku 4.5 is NOT adaptive-thinking (uses budget-based thinking, no effort knob),
// so it stays single-variant with no suffix; reasoning controls thinking on/off
// there as before.

const ADAPTIVE_THINKING_BASE_IDS = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"] as const;

export const MODEL_IDS_IN_ORDER = [
	"claude-opus-4-7-thinking", "claude-opus-4-7-instant",
	"claude-opus-4-6-thinking", "claude-opus-4-6-instant",
	"claude-sonnet-4-6-thinking", "claude-sonnet-4-6-instant",
	"claude-haiku-4-5",
];

const VARIANT_TO_BASE: Record<string, string> = Object.fromEntries(
	ADAPTIVE_THINKING_BASE_IDS.flatMap((id) => [
		[`${id}-thinking`, id],
		[`${id}-instant`, id],
	] as Array<[string, string]>),
);

/** Strip `-thinking`/`-instant` suffix to get the real Anthropic model ID for the CC binary. */
export function baseModelId(variantId: string): string {
	return VARIANT_TO_BASE[variantId] ?? variantId;
}

/**
 * "on"  — `-thinking` variant: force thinking blocks visible.
 * "off" — `-instant` variant: force thinking off (overrides settings.json).
 * undefined — non-adaptive model (haiku): preserve legacy behavior (reasoning gates thinking).
 */
export function thinkingModeFor(variantId: string): "on" | "off" | undefined {
	if (variantId.endsWith("-thinking")) return "on";
	if (variantId.endsWith("-instant")) return "off";
	return undefined;
}

// Per-base-model thinkingLevelMap. Values do double duty:
//   - non-null = level appears in pi's selector
//   - null     = level hidden
//   - the string is also the literal effort value sent to the Anthropic API
//     (read by `effortFor()` below — pi-claude-bridge respects per-model mappings
//     instead of a single global table, matching pi-ai's `mapThinkingLevelToEffort`).
//
// Common rules across all adaptive Claude models:
//   - `off`     hidden — Anthropic appears to default to ~high effort when no level
//                        is sent, so an "off" pick is misleading. Force explicit choice.
//   - `minimal` hidden — Anthropic's effort enum has no `minimal`; would silently
//                        collapse to `low`.
//
// Per-model effort mapping. Pi's selector enum is `off|minimal|low|medium|high|xhigh`
// (6 slots) but Anthropic's adaptive-thinking effort enum on Opus is 5 distinct
// values (`low|medium|high|xhigh|max`) — one too many to fit in pi's 4 useful slots
// (`low|medium|high|xhigh`) without losing one. To expose all 5, Opus models
// SHIFT pi's labels down one slot:
//
//      Pi label:     minimal   low      medium   high     xhigh
//      Opus effort:  low       medium   high     xhigh    max
//
// Tradeoff: each pi label is one tier "lower" than what's actually sent to the
// API. We can't fix this until pi-coding-agent's thinking-selector exposes
// custom slot labels (the level names in the picker are hardcoded; only
// visibility is per-model).
//
// Sonnet 4.6 has only 4 effort values (`low|medium|high|max` — no `xhigh`),
// so it fits pi's 4 slots cleanly with the natural label-aligned mapping.
function thinkingLevelMapFor(baseId: string): Record<string, string | null> {
	if (baseId === "claude-opus-4-6" || baseId === "claude-opus-4-7") {
		// Shift: pi's 5 visible slots → Anthropic's 5 effort tiers (off-by-one labels)
		return { off: null, minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" };
	}
	if (baseId === "claude-sonnet-4-6") {
		// Natural alignment: 4 pi slots → 4 sonnet effort tiers (labels accurate)
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max" };
	}
	// Fallback (shouldn't trigger — only adaptive models call this)
	return { off: null, minimal: null, low: "low", medium: "medium", high: "high" };
}

/**
 * Resolve a pi reasoning level → Anthropic effort string for a given model variant.
 * Reads the model's thinkingLevelMap; falls back to identity for unmapped levels.
 * Returns undefined for `off` / `minimal` / unmapped levels (no effort flag sent).
 */
export function effortFor(variantId: string, reasoning: string): string | undefined {
	const map = thinkingLevelMapFor(baseModelId(variantId));
	const mapped = map[reasoning];
	if (mapped === null) return undefined;
	return mapped ?? undefined;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// fan adaptive-thinking models out into two variants, and keep MODEL_IDS_IN_ORDER ordering.
// IDs missing from pi-ai are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	const byId = new Map(piAiModels.map((m) => [m.id, m]));
	return MODEL_IDS_IN_ORDER
		.map((variantId) => {
			const base = byId.get(baseModelId(variantId));
			if (!base) return null;
			const mode = thinkingModeFor(variantId);
			const { name, reasoning, input, contextWindow, maxTokens } = base;
			const baseName = name ?? base.id;
			let displayName: string;
			if (mode === "on") displayName = `${baseName} (thinking)`;
			else if (mode === "off") displayName = `${baseName} (instant)`;
			else displayName = baseName;
			return {
				id: variantId,
				name: displayName,
				reasoning, input, contextWindow, maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...(mode !== undefined ? { thinkingLevelMap: thinkingLevelMapFor(baseModelId(variantId)) } : {}),
			};
		})
		.filter((m): m is NonNullable<typeof m> => m != null);
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	// Exact match wins — otherwise the `-thinking` variant (listed first) would
	// shadow `-instant` for inputs like "claude-opus-4-7-instant".
	const exact = models.find((m) => m.id === lower);
	if (exact) return exact.id;
	const partial = models.find((m) => m.id.includes(lower));
	return partial ? partial.id : input;
}
