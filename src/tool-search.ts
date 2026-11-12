// provider.toolSearch: let Claude Code defer pi's tool schemas behind its ToolSearch tool.
//
// The provider path runs Claude Code without its builtins, which also removes
// ToolSearch, so CC sends every pi tool's schema on every request. With ToolSearch
// among CC's tools, CC sends in full only the tools our MCP server marks
// `_meta["anthropic/alwaysLoad"]` and announces the others by name. The model loads
// one with a ToolSearch call, which CC answers itself with a `tool_reference`, and
// calls it in the same turn (measured: diag/probe-tool-search.mjs).
//
// Kept apart from index.ts so tests can import it without activating the extension.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Config } from "./config.js";

/** Claude Code's tool search tool (BUILTIN_TOOL_NAMES in sdk.d.ts). */
export const TOOL_SEARCH_TOOL = "ToolSearch";

/** Never deferred: pi's file tools, its two tools that reach other tools, and AskClaude. */
export const DEFAULT_ALWAYS_LOAD = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "tool_search", "codemode", "AskClaude"];

export interface ToolSearchSettings {
	/** Tool names, or patterns where `*` matches any characters. */
	alwaysLoad: string[];
}

/** provider.toolSearch and provider.alwaysLoadTools, or undefined when tool search is
 *  off. Validated here: a malformed value must not fail activation. */
export function toolSearchSettings(provider: Config["provider"] = {}): ToolSearchSettings | undefined {
	if (provider.toolSearch !== true) return undefined;
	const configured = Array.isArray(provider.alwaysLoadTools)
		? provider.alwaysLoadTools.filter((pattern): pattern is string => typeof pattern === "string" && pattern !== "")
		: [];
	return { alwaysLoad: [...DEFAULT_ALWAYS_LOAD, ...configured] };
}

function matches(name: string, pattern: string): boolean {
	if (!pattern.includes("*")) return name === pattern;
	const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/** Folded into a session's prompt digest, so turning tool search on or off, or
 *  changing the list, takes a full import. Claude Code keeps tool search off for a
 *  conversation that started without ToolSearch, whatever a later resume asks for. */
export function toolSearchDigest(settings: ToolSearchSettings): string {
	return `\0tool-search\0${JSON.stringify(settings.alwaysLoad)}`;
}

/** The tools to defer for a Claude Code session whose history the bridge writes from
 *  `messages`. A tool that history already calls is loaded instead: Claude Code only
 *  knows a deferred tool is loaded from the `tool_reference` its own search left
 *  behind, and a transcript written from pi's history has none. */
export function deferredToolNames(toolNames: readonly string[], messages: readonly PiMessage[], settings: ToolSearchSettings): string[] {
	const called = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") called.add(block.name);
	}
	return toolNames.filter((name) => !called.has(name) && !settings.alwaysLoad.some((pattern) => matches(name, pattern)));
}
