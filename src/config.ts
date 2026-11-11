// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json).
// There is no project config: a cloned repo could otherwise point the bridge at
// its own Claude Code executable or turn on metered billing. A missing or
// unparseable file is ignored (error to console.error, empty object returned)
// so the extension always starts.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
	/** Removed: AskClaude is its own package. Read only to warn whoever still has it enabled. */
	askClaude?: { enabled?: boolean };
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context;
		// newer models get 1M on every plan.
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
		// Put Claude Code's own preset in front of pi's prompt, with pi's whole prompt
		// as its append. Off by default: pi's prompt is the whole system prompt. Only
		// "claude_code" is valid; any other value is a startup error.
		systemPromptPreset?: "claude_code";
	};
}

function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	const preset = global.provider?.systemPromptPreset;
	if (preset !== undefined && preset !== "claude_code") {
		throw new Error(`claude-bridge: provider.systemPromptPreset must be "claude_code" or unset, got ${JSON.stringify(preset)}`);
	}
	return { askClaude: global.askClaude, provider: { ...global.provider } };
}
