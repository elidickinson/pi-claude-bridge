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
		/** @deprecated Use systemPromptMode instead. true=append, false=disabled. */
		appendSystemPrompt?: boolean;
		/** Controls how pi's system prompt (AGENTS.md + skills) is fed to Claude Code. */
		systemPromptMode?: "append" | "replace" | false;
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
		// Set to true to opt into 1M context usage that costs credits ("extra usage"
		// in Anthropic billing). Applies to all 1M-capable models (Opus 4.6/4.7/4.8,
		// Sonnet 4.6). Sonnet 1M is metered on every plan (including Max); Opus 1M
		// is metered on Pro but included on Max (use plan setting instead).
		// Defaults to false (200K for every model).
		longContextExtraUsage?: boolean;
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

/**
 * Resolves the effective systemPromptMode, handling the deprecated appendSystemPrompt
 * boolean alias for backward compatibility.
 * - "append": CC default + pi's AGENTS.md/skills appended (original behavior)
 * - "replace": only pi's AGENTS.md/skills, CC default is not loaded
 * - false: no system prompt at all
 */
export type SystemPromptMode = "append" | "replace" | false;

export function resolveSystemPromptMode(provider: Config["provider"]): SystemPromptMode {
	if (provider?.appendSystemPrompt !== undefined) {
		return provider.appendSystemPrompt ? "append" : false;
	}
	return provider?.systemPromptMode ?? "append";
}
