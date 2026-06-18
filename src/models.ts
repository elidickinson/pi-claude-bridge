// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
//
// Models with a >200K advertised window get a visible [1m] suffix in the
// display name, but keep their registered ids stable/bare. The spawned Claude
// Code CLI enables its 1M context window only when the model string passed to
// --model contains [1m], so claudeCodeModelId() adds that suffix at the CLI
// boundary. Unlike the context-1m-2025-08-07 beta (issue #24), this works under
// Pro/Max subscription (OAuth) auth, where the CLI ignores custom betas
// ("Custom betas are only available for API key users.").
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => {
			const oneM = hasOneMContext({ contextWindow });
			return {
				id,
				name: oneM && typeof name === "string" && !name.includes("[1m]") ? `${name} [1m]` : name,
				reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		});
}

export function hasOneMContext(model: { contextWindow?: number | null }): boolean {
	return (model.contextWindow ?? 0) > 200_000;
}

export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }): string {
	return hasOneMContext(model) && !model.id.includes("[1m]") ? `${model.id}[1m]` : model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}
