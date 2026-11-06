// Model selection + display-order policy for the model picker. The picker is
// driven by pi-ai's anthropic catalog: models appear (and disappear) with it,
// no per-model code here. Extracted from index.ts so tests can import without
// activating the extension.

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// pi-ai ships dated snapshot ids (claude-opus-4-5-20251101, ...) alongside the
// bare ids. They are never exposed.
function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

// Family tiers for display order: flagship families first; unknown families
// sink below all known ones.
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// newest generation first. Context-dependent display labels are applied after
// plan/long-context config is known.
// Version rank of a claude id, e.g. claude-opus-4-7 → ["opus", 4, 7], for the display sort.
function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family, major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return piAiModels
		.filter((m) => typeof m.id === "string" && !isDatedAlias(m.id))
		.sort((a, b) => {
			const fa = FAMILY_ORDER.indexOf(versionRank(a.id).family);
			const fb = FAMILY_ORDER.indexOf(versionRank(b.id).family);
			const ta = fa === -1 ? FAMILY_ORDER.length : fa;
			const tb = fb === -1 ? FAMILY_ORDER.length : fb;
			if (ta !== tb) return ta - tb;
			const ra = versionRank(a.id).tuple;
			const rb = versionRank(b.id).tuple;
			if (ra[0] !== rb[0]) return rb[0] - ra[0];
			if (ra[1] !== rb[1]) return rb[1] - ra[1];
			return a.id.localeCompare(b.id);
		})
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// The picker is the anthropic catalog, so an endpoint that serves ids outside it
// (a gateway or router behind ANTHROPIC_BASE_URL) offers nothing selectable and a
// turn cannot target its models. Extras are opt-in, never baked in: the env var
// holds a comma-separated list of `id[:contextWindow[:maxTokens]]`. The limits are
// the trailing numeric fields only, so colon-bearing ids survive; an id that
// itself ends in a number is read as carrying a limit (no escape in the syntax).
// Empty by default, which leaves the catalog alone.
const EXTRA_CONTEXT_WINDOW = TWO_HUNDRED_K_CONTEXT;
const EXTRA_MAX_TOKENS = 32_000;

// A window that does not parse is a typo, not a request for a zero-token model.
function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
	const value = Number(raw);
	return value > 0 ? value : fallback;
}

// Split `id[:contextWindow[:maxTokens]]` at its trailing limit fields only. Served
// ids carry colons of their own (`meta-llama/llama-3.2-3b-instruct:free`,
// `anthropic/claude-opus-5:nitro`), and splitting on every colon registered `free`
// as the id with the variant unselectable — so a limit can only start at a numeric
// last field. The field before that one is the window slot when it is numeric or
// empty; any other value (a variant suffix such as `free`) stays in the id, which
// also means a typo like `my-model:200k:0` registers `my-model:200k` rather than
// silently dropping the field. A trailing colon is an empty limit slot, not part
// of an id. The flat syntax has no escape, so an id genuinely ending in `:200000`
// is indistinguishable from a window and is read as one.
function splitExtraModelSpec(entry: string): { id: string; contextWindow?: string; maxTokens?: string } {
	const spec = entry.replace(/:+$/, "");
	const parts = spec.split(":");
	if (parts.length < 2 || !/^\d+$/.test(parts[parts.length - 1])) return { id: spec };
	const last = parts[parts.length - 1];
	const previous = parts[parts.length - 2];
	if (parts.length > 2 && (previous === "" || /^\d+$/.test(previous))) {
		return { id: parts.slice(0, -2).join(":"), contextWindow: previous, maxTokens: last };
	}
	return { id: parts.slice(0, -1).join(":"), contextWindow: last };
}

// Project the extra ids to the same shape as buildModels' entries. Cost is zero —
// the endpoint's billing is unknown to us — and input is text-only: an image sent
// to a model that does not take one fails the turn.
export function buildExtraModels(spec: string | undefined, knownIds: Iterable<string> = []) {
	const known = new Set(knownIds);
	const seen = new Set<string>();
	const models: {
		id: string; name: string; reasoning: boolean; input: ("text" | "image")[];
		contextWindow: number; maxTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	}[] = [];
	for (const entry of (spec ?? "").split(",")) {
		const { id, contextWindow, maxTokens } = splitExtraModelSpec(entry.trim());
		// An id the catalog already lists keeps the catalog's metadata (and its
		// [1m]/200K policy); registering it again would list it twice in the picker.
		if (!id || seen.has(id) || known.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			contextWindow: positiveInt(contextWindow, EXTRA_CONTEXT_WINDOW),
			maxTokens: positiveInt(maxTokens, EXTRA_MAX_TOKENS),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return models;
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	// Model ids whose declared 1M context Claude Code turned out not to serve;
	// forces bare id at 200K without a code change.
	forceTwoHundredK?: string[];
};

type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Measured Claude Agent SDK behavior - see diag/CONTEXT-SIZE.md:
// - The `[1m]` suffix is the only reliable way to request 1M context through
//   the SDK; bare ids serve 200K.
// - An unentitled `[1m]` id is rejected outright (400/429), failing every turn
//   — worse than serving 200K, so the default is bare id at 200K and only
//   measured-good ids get `[1m]`.
// - The registered contextWindow must match the window the bridge actually
//   requests, or pi's status bar and compaction threshold misreport.
// [1m] ids verified to serve 1M on every plan (sonnet-5-5 measured on Pro with
// and without Extra Usage; opus-5-5 on Max per its run notes). A new model
// serves 200K until someone measures it (diag/context-size.mjs) and adds it
// here. Known exception unrelated to long context: fable-5 is not included
// with Pro account without Extra Usage.
const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
  "claude-sonnet-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
]);

// Measured exceptions: pi-ai declares 1M and the [1m] id works, but only when
// the plan allows it.
const PLAN_GATED_ONE_M: Record<string, (settings: LongContextSettings) => boolean> = {
	// [1m] measured 1M on Max plan / extra usage; 429 on Pro without it.
	"claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
	// [1m] measured 1M with extra usage only.
	"claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
};

export function resolveClaudeCodeRuntimeModel(
	model: { id: string },
	settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
	const modelId = model.id;
	if (settings.forceTwoHundredK?.includes(modelId)) {
		return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
	if (MEASURED_ONE_M.has(modelId)) {
		return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
	}
	const planGate = PLAN_GATED_ONE_M[modelId];
	if (planGate) {
		const useOneM = planGate(settings);
		return {
			cliModelId: useOneM ? `${modelId}[1m]` : modelId,
			contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
		};
	}
	// No measured row: bare id at 200K, the safe default (see diag/CONTEXT-SIZE.md).
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model, settings).cliModelId;
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
