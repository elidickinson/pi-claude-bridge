// User-facing extension config. Loaded once at extension registration from
// ~/.pi/agent/claude-bridge.json and .pi/claude-bridge.json, project overriding
// global. Missing or unparseable files are ignored (error to console.error,
// empty object returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
		// Subscription plan tier, controls the registered contextWindow for a bare
		// (unlisted) Opus id: "pro" (default) → Opus runs at 200K so registers 200K;
		// "max" → Claude Code auto-upgrades bare Opus to 1M so registers 1M (without
		// appending [1m], avoiding #39841). Use "max" for Max, Team Premium,
		// Enterprise pay-as-you-go, or Anthropic API. Only Opus auto-upgrades; Sonnet
		// and Haiku are unaffected. See README.
		plan?: "pro" | "max";
		// Bare model ids (e.g. "claude-opus-4-8") to opt into 1M (long) context for.
		// Only long-context-capable models (>200K advertised window: Opus 4.6+,
		// Sonnet 4.6) are affected; Haiku 4.5 (200K) and any id not listed stay on
		// the 200K default. 1M is metered on every plan for Sonnet (including Max)
		// and included for Opus on Max/Team/Enterprise — opt in per model accordingly.
		// See README.
		enableLongContextModels?: string[];
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
