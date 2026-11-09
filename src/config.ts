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

export function modelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

// pi accepts JSONC in models.json. Keep the bridge's read consistent without
// adding a dependency: remove comments outside strings, retaining newlines so
// parse errors still point at a useful line.
function stripJsonComments(source: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < source.length; i++) {
		const current = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (current === "\n" || current === "\r") {
				lineComment = false;
				output += current;
			}
			continue;
		}
		if (blockComment) {
			if (current === "*" && next === "/") {
				blockComment = false;
				i++;
			} else if (current === "\n" || current === "\r") {
				output += current;
			}
			continue;
		}
		if (inString) {
			output += current;
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === '"') inString = false;
			continue;
		}
		if (current === '"') {
			inString = true;
			output += current;
		} else if (current === "/" && next === "/") {
			lineComment = true;
			i++;
		} else if (current === "/" && next === "*") {
			blockComment = true;
			i++;
		} else {
			output += current;
		}
	}
	return output;
}

export function loadModelsJson(): unknown {
	const path = modelsJsonPath();
	if (!existsSync(path)) return {};
	try {
		const source = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
		return JSON.parse(stripJsonComments(source));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	return { askClaude: global.askClaude, provider: { ...global.provider } };
}
