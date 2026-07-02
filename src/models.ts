// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

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

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, and [1m] entitlement differs by model. See diag/CONTEXT-SIZE.md.
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	switch (modelId) {
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
    case "claude-fable-5":
      return { cliModelId: modelId, contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: modelId, contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`);
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
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
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}

// --- Adaptive thinking + effort resolution ---
//
// On adaptive-thinking models (all 4.6+ Claude models) `thinking` is a separate
// on/off axis from `effort`: thinking=disabled skips the reasoning phase
// entirely, effort still governs output thoroughness. Every bridge model is
// adaptive except Haiku 4.5 (budget-based thinking, no effort knob). Unknown
// ids (arbitrary AskClaude model params) are treated as non-adaptive so we
// never send flags a model might not support.
const BUDGET_THINKING_MODEL_IDS = new Set(["claude-haiku-4-5"]);

export function isAdaptiveModel(modelId: string): boolean {
	return MODEL_IDS_IN_ORDER.includes(modelId) && !BUDGET_THINKING_MODEL_IDS.has(modelId);
}

// Fallback effort map for levels a model's thinkingLevelMap doesn't override.
// pi-ai ships only the xhigh override per model (e.g. opus-4-7: {xhigh:"xhigh"},
// opus-4-6: {xhigh:"max"}); low/medium/high fall through here.
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

export interface ThinkingResolution {
	/** Effort to pass to the SDK, or undefined to send none (CC picks). */
	effort?: EffortLevel;
	/** SDK thinking option. Always set for adaptive models so pi's slider is
	 * authoritative: `~/.claude/settings.json` (`alwaysThinkingEnabled`) can
	 * neither re-enable reasoning when off nor disable it when on (both verified
	 * live — without an explicit flag, settings win in each direction). */
	thinking?: ThinkingConfig;
}

const ADAPTIVE_ON: ThinkingConfig = {
	type: "adaptive",
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in
	// stream). Force summarized so thinking_delta events arrive.
	// See anthropics/claude-agent-sdk-python#830.
	display: "summarized",
};

// Resolve pi's reasoning level into SDK thinking/effort options for one model.
// pi sends `reasoning: undefined` when its thinking slider is off (see
// pi-mono agent.ts); AskClaude passes the literal "off". Both mean off here.
//   - adaptive + off   → thinking disabled, effort = effortWhenOff — deterministic
//                        instead of falling back to CC's settings-dependent default.
//                        If pi-ai marks off unsupported (thinkingLevelMap.off === null)
//                        clamp to minimal like pi's own slider does — fable-5 ignores
//                        thinking:disabled and thinks anyway (verified live).
//   - adaptive + level → thinking adaptive, effort from the model's thinkingLevelMap
//                        or the fallback table
//   - non-adaptive     → legacy: effort from table, no thinking flag; off sends nothing
export function resolveThinking(
	modelId: string,
	reasoning: string | undefined,
	effortWhenOff: EffortLevel,
	thinkingLevelMap?: Record<string, string | null>,
): ThinkingResolution {
	let level = reasoning ?? "off";
	if (level === "off") {
		if (!isAdaptiveModel(modelId)) return {};
		if (thinkingLevelMap?.off !== null) return { effort: effortWhenOff, thinking: { type: "disabled" } };
		level = "minimal";
	}
	const mapped = thinkingLevelMap?.[level] as EffortLevel | undefined;
	const effort = mapped ?? REASONING_TO_EFFORT[level];
	return isAdaptiveModel(modelId) ? { effort, thinking: ADAPTIVE_ON } : { effort };
}
