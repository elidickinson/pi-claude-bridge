// User-facing extension config. Loaded once at extension registration from
// ~/.pi/agent/claude-bridge.json and .pi/claude-bridge.json, project overriding
// global. Missing or unparseable files are ignored (error to console.error,
// empty object returned) so the extension always starts.

import type { EffortLevel, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ModelsJsonModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: string[];
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	contextWindow?: number;
	maxTokens?: number;
}

export interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		pathToClaudeCodeExecutable?: string;
		/** Expose `-instant` virtual model variants for adaptive-thinking models. Defaults true. */
		instantVariants?: boolean;
		/** Effort to send when pi's reasoning level is `off` on a thinking-visible adaptive model. Defaults high. */
		effortWhenReasoningOff?: EffortLevel;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".pi", "agent", "claude-bridge.json"));
	const project = tryParseJson(join(cwd, ".pi", "claude-bridge.json"));
	return {
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
	};
}

export function loadModelsJsonProviderModels(providerId: string): ModelsJsonModel[] | undefined {
	const modelsJson = tryParseJson(join(homedir(), ".pi", "agent", "models.json")) as any;
	const models = modelsJson?.providers?.[providerId]?.models;
	return Array.isArray(models) ? models : undefined;
}
