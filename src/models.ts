// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Models newer than the installed pi-ai's registry: clone the named base entry
// (same params) and override id/name. Remove an entry once pi-ai ships its
// official definition and the `piAiModels.find` below picks it up directly.
const SYNTHETIC_MODELS: Record<string, { base: string; name: string }> = {
	"claude-opus-4-8": { base: "claude-opus-4-7", name: "Claude Opus 4.8" },
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai (and without a
// synthetic fallback) are silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => {
			const found = piAiModels.find((m) => m.id === id);
			if (found) return found;
			const synthetic = SYNTHETIC_MODELS[id];
			if (!synthetic) return undefined;
			const base = piAiModels.find((m) => m.id === synthetic.base);
			return base ? ({ ...base, id, name: synthetic.name } as T) : undefined;
		})
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	const match = models.find((m) => m.id === lower || m.id.includes(lower));
	return match ? match.id : input;
}
