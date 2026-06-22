// System prompt + settingSources assembly, shared by streamClaudeAgentSdk
// (the main provider path) and promptAndWait (the AskClaude tool path).
//
// Pulled out of index.ts so the per-mode shape is unit-testable. The original
// inline implementation computed extracts unconditionally, which silently sent
// a ~6k string when `systemPromptMode: false` was selected (issue surfaced in
// manual review). This module gates extracts on mode and adds a fourth
// "legacy-preset-only" mode that preserves the 0.4.0 behavior of the
// deprecated `appendSystemPrompt: false` flag.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { resolveSystemPromptMode, type Config, type SystemPromptMode } from "./config.js";
import { extractAgentsAppend } from "./agents-md.js";
import { extractSkillsBlock } from "./skills.js";

export type SystemPromptOption =
	| string
	| { type: "preset"; preset: "claude_code"; append?: string };

export interface SystemPromptConfig {
	/** Value to pass as `systemPrompt` to the SDK query options. */
	systemPrompt: SystemPromptOption;
	/** Value to pass as `settingSources`, or undefined to use the SDK default. */
	settingSources: SettingSource[] | undefined;
	/** Resolved mode (for debug logging). */
	mode: SystemPromptMode;
}

export interface ResolveSystemPromptOptions {
	/** Include AGENTS.md content from the cwd tree (default: true). */
	includeAgentsMd?: boolean;
	/** Include extracted skills block (default: true). */
	includeSkills?: boolean;
}

/**
 * Resolves the system prompt + settingSources per the configured mode.
 *
 * @param provider  The `provider` slice of the loaded config (may be undefined).
 * @param piSystemPrompt  pi's full system prompt (`context.systemPrompt` for
 *                        the main path, `options.systemPrompt` for AskClaude).
 *                        Used verbatim in `replace` mode; consulted for skills
 *                        extraction in `append` and `legacy-preset-only` modes.
 * @param options.includeAgentsMd  Set false to skip AGENTS.md walking
 *                                 (AskClaude tool does not pull project
 *                                 AGENTS.md; main provider path does).
 * @param options.includeSkills   Set false to skip skills extraction
 *                                 (AskClaude callers can disable per-call).
 */
export function resolveSystemPromptConfig(
	provider: Config["provider"] | undefined,
	piSystemPrompt: string | undefined,
	options: ResolveSystemPromptOptions = {},
): SystemPromptConfig {
	const settings = provider ?? {};
	const mode = resolveSystemPromptMode(settings);
	const includeAgentsMd = options.includeAgentsMd ?? true;
	const includeSkills = options.includeSkills ?? true;

	switch (mode) {
		case "append": {
			// CC preset + AGENTS.md + (rewritten) skills appended.
			// settingSources defaults to undefined = SDK loads all sources
			// (matches upstream 0.4.0 default behavior).
			const agentsAppend = includeAgentsMd ? extractAgentsAppend() : undefined;
			const skillsAppend = includeSkills && piSystemPrompt
				? extractSkillsBlock(piSystemPrompt) : undefined;
			const parts = [agentsAppend, skillsAppend].filter((p): p is string => Boolean(p));
			const append = parts.length > 0 ? parts.join("\n\n") : undefined;
			return {
				systemPrompt: { type: "preset", preset: "claude_code", append },
				settingSources: settings.settingSources,
				mode,
			};
		}

		case "legacy-preset-only": {
			// Exact 0.4.0 behavior for users on the deprecated
			// `appendSystemPrompt: false` flag. Preset kept, no pi additions,
			// settingSources falls back to ["user","project"] when not
			// user-configured.
			return {
				systemPrompt: { type: "preset", preset: "claude_code", append: undefined },
				settingSources: settings.settingSources ?? ["user", "project"],
				mode,
			};
		}

		case "replace": {
			// pi+Sonnet-as-a-model mode. Pass pi's prompt through verbatim so
			// the model sees what it would see running inside pi directly. CC
			// settings/CLAUDE.md are explicitly opted out via empty array.
			return {
				systemPrompt: piSystemPrompt ?? "",
				settingSources: [],
				mode,
			};
		}

		case false: {
			// No system prompt at all. Empty string is the documented SDK
			// representation. CC settings also opted out so nothing else
			// injects a prompt via the back door.
			return {
				systemPrompt: "",
				settingSources: [],
				mode,
			};
		}
	}
}