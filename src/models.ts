// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// A model is 1M-*capable* when its advertised window exceeds 200K. Capability is
// not entitlement: Sonnet 4.6's 1M is metered on every plan (including Max), while
// Opus 1M is included on Max/Team/Enterprise. Capability only gates whether opting
// in via provider.longContextExtraUsage has any effect.
export function hasOneMContext(model: { contextWindow?: number | null }): boolean {
	return (model.contextWindow ?? 0) > 200_000;
}

// Append [1m] to the CLI model id only when the model is 1M-capable AND the user
// has opted in for that specific model. The [1m] suffix is what tells the Claude
// Code CLI to open its 1M window; the bare id keeps the 200K default. Unlike the
// context-1m-2025-08-07 beta (issue #24), the model-id path works under
// Pro/Max subscription (OAuth) auth, where the CLI ignores custom betas.
export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }, oneMEnabled: boolean): string {
	return oneMEnabled && hasOneMContext(model) && !model.id.includes("[1m]") ? `${model.id}[1m]` : model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport: registering 1M while the CLI
// runs at 200K recreates the "pi shows headroom but CC errors with Prompt is too
// long / credit gate" bug (issue #24, #17). Three cases:
//   1. Opted into longContextModelIds → sends [1m], runtime 1M → register 1M.
//   2. plan "max" + bare Opus → CC auto-upgrades to 1M (default since v2.1.75) →
//      register 1M WITHOUT [1m], avoiding the usage-credits gate an explicit
//      opus[1m] can trip on Max 5x (#39841). Only Opus auto-upgrades; Sonnet's 1M
//      always requires explicit [1m] + credits.
//   3. Everything else (Sonnet bare, Opus on Pro, Haiku) → runtime 200K → register 200K.
export function applyLongContext<T extends { id: string; contextWindow?: number | null }>(
	models: T[],
	longContextModelIds: Set<string>,
	plan: "pro" | "max",
): T[] {
	return models.map((m) => {
		if (longContextModelIds.has(m.id) && hasOneMContext(m)) return m;
		if (plan === "max" && m.id.includes("opus") && hasOneMContext(m)) return m;
		const capped = Math.min(m.contextWindow ?? 200_000, 200_000);
		return capped === m.contextWindow ? m : { ...m, contextWindow: capped };
	});
}

export function applyOneMDisplayNames<T extends { name: string; contextWindow?: number | null }>(models: T[]): T[] {
	return models.map((m) => {
		if (!hasOneMContext(m) || /\b1M\b/i.test(m.name)) return m;
		return { ...m, name: `${m.name} 1M` };
	});
}
