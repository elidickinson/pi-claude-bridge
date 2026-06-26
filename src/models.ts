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
// Opus 1M is included on Max/Team/Enterprise. Capability only gates whether a
// 1M opt-in can have any effect.
export function hasOneMContext(model: { contextWindow?: number | null }): boolean {
	return (model.contextWindow ?? 0) > 200_000;
}

export function resolveOneMEnabledIds<T extends { id: string; contextWindow?: number | null }>(
	models: T[],
	plan: "pro" | "max",
	longContextExtraUsage: boolean,
): Set<string> {
	return new Set(models
		.filter((m) => hasOneMContext(m))
		.filter((m) => longContextExtraUsage || (plan === "max" && m.id.includes("opus")))
		.map((m) => m.id));
}

// Append [1m] to the CLI model id only when the model is 1M-capable AND enabled
// for 1M. The [1m] suffix is what tells the Claude Code CLI to open its 1M
// window; the bare id can be served as 200K even on Max. Unlike the
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
// long" bug (issue #24, #17, #18). `oneMEnabledModelIds` must match the models
// that will be sent to Claude Code with [1m]. Everything else is capped to 200K.
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	oneMEnabledModelIds: Set<string>,
): T[] {
	return models.map((m) => {
		const contextWindow = oneMEnabledModelIds.has(m.id) && hasOneMContext(m)
			? m.contextWindow
			: Math.min(m.contextWindow ?? 200_000, 200_000);
		const name = hasOneMContext({ contextWindow }) && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
