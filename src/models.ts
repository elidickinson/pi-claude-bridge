import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

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

// The registration contract for a bridge model. Catalog entries and models.json
// additions share it so both are accepted by pi.registerProvider.
export interface BridgeModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type CatalogModel = Omit<BridgeModel, "cost">;

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// newest generation first. Context-dependent display labels are applied after
// plan/long-context config is known.
// Version rank of a claude id, e.g. claude-opus-4-7 → ["opus", 4, 7], for the display sort.
function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family, major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

export function buildModels(piAiModels: readonly CatalogModel[]): BridgeModel[] {
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

// pi-ai's catalog is the picker. A gateway or router behind ANTHROPIC_BASE_URL
// can serve ids outside it, so models.json may add them under
// providers["claude-bridge"].models. Entries are additive only: catalog ids and
// their measured [1m]/200K policy stay authoritative, and the bridge never
// rewrites an extra's declared window. pi validates models.json before this
// extension registers, so each entry needs api/baseUrl (provider-level or per
// model) even though the bridge ignores both values.
const EXTRA_CONTEXT_WINDOW = 128_000;
const EXTRA_MAX_TOKENS = 16_384;

export type ExtraModelIssue = { id?: string; message: string };
export type ExtraModelsResult = { models: BridgeModel[]; issues: ExtraModelIssue[] };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function costNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function modelCost(value: unknown): BridgeModel["cost"] {
	const cost = record(value);
	return {
		input: costNumber(cost?.input),
		output: costNumber(cost?.output),
		cacheRead: costNumber(cost?.cacheRead),
		cacheWrite: costNumber(cost?.cacheWrite),
	};
}

function modelInput(value: unknown): BridgeModel["input"] {
	if (!Array.isArray(value)) return ["text"];
	const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input.length > 0 ? input : ["text"];
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function modelThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	const map = record(value);
	if (!map) return undefined;
	const result: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		const entry = map[level];
		if (typeof entry === "string") result[level] = entry;
		else if (entry === null) result[level] = null;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

// Read only the standard models.json additions for this provider. The bridge
// provider is registered with its own model list, so pi's applyModelsJson would
// otherwise add these models and the extension replacement would discard them.
export function extraModelsFromJson(
	modelsJson: unknown,
	knownIds: Iterable<string> = [],
): ExtraModelsResult {
	const provider = record(record(record(modelsJson)?.providers)?.["claude-bridge"]);
	if (!provider) return { models: [], issues: [] };
	if (provider.models === undefined) return { models: [], issues: [] };
	if (!Array.isArray(provider.models)) {
		return { models: [], issues: [{ message: 'providers["claude-bridge"].models must be an array' }] };
	}

	const providerApi = nonEmptyString(provider.api);
	const providerBaseUrl = nonEmptyString(provider.baseUrl);
	const known = new Set(knownIds);
	const seen = new Set<string>();
	const models: BridgeModel[] = [];
	const issues: ExtraModelIssue[] = [];
	for (const raw of provider.models) {
		const definition = record(raw);
		const id = nonEmptyString(definition?.id);
		if (!definition || !id) {
			issues.push({ message: 'each providers["claude-bridge"].models entry needs a non-empty "id"' });
			continue;
		}
		const api = nonEmptyString(definition.api) ?? providerApi;
		const baseUrl = nonEmptyString(definition.baseUrl) ?? providerBaseUrl;
		if (api !== "claude-bridge" || baseUrl !== "claude-bridge") {
			issues.push({
				id,
				message: `model "${id}" needs "api": "claude-bridge" and "baseUrl": "claude-bridge" at the provider or model level`,
			});
			continue;
		}
		// An id the catalog already lists keeps the catalog's metadata (and its
		// [1m]/200K policy); registering it again would list it twice in the picker.
		if (known.has(id)) {
			issues.push({ id, message: `model "${id}" is already in pi-ai's catalog; the catalog entry wins` });
			continue;
		}
		if (seen.has(id)) {
			issues.push({ id, message: `model "${id}" is listed more than once; the first entry wins` });
			continue;
		}
		seen.add(id);
		const thinkingLevelMap = modelThinkingLevelMap(definition.thinkingLevelMap);
		models.push({
			id,
			name: nonEmptyString(definition.name) ?? id,
			reasoning: typeof definition.reasoning === "boolean" ? definition.reasoning : false,
			input: modelInput(definition.input),
			contextWindow: positiveNumber(definition.contextWindow) ?? EXTRA_CONTEXT_WINDOW,
			maxTokens: positiveNumber(definition.maxTokens) ?? EXTRA_MAX_TOKENS,
			cost: modelCost(definition.cost),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		});
	}
	return { models, issues };
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
// - The `[1m]` suffix is the reliable way to request 1M context through the
//   SDK. Bare ids serve 1M for current models on Pro, but older models and some
//   Max-plan measurements serve 200K.
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
