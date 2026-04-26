// User-facing extension config: AskClaude feature flags and tool description
// overrides. Loaded once at extension registration from
// ~/.pi/agent/claude-bridge.json and .pi/claude-bridge.json, project
// overriding global. Missing or unparseable files are ignored (error to
// console.error, empty object returned) so the extension always starts.
// Separate from provider-settings.ts, which reads SDK plumbing out of pi's
// shared settings.json.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
	/** @deprecated Unsafe: can slice mid-tool-sequence causing orphaned tool_result without matching tool_use */
	maxHistoryMessages?: number;
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
		maxHistoryMessages: project.maxHistoryMessages ?? global.maxHistoryMessages,
		askClaude: { ...global.askClaude, ...project.askClaude },
	};
}
