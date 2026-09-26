#!/usr/bin/env node

/**
 * Positive purpose discriminator for the isolated summary path.
 *
 * cacheRetention:"none" is a cache preference, not a purpose marker
 * (@earendil-works/pi-ai types.d.ts:132-136). The bridge used to route every
 * such call into the isolated one-off summary path, which would have destroyed
 * history/tools for ordinary no-cache inference. Routing now keys on installed
 * pi 0.87.1's dedicated summary prompts, returned verbatim inside the leading
 * system message pi-ai's normalizeContext folds systemPrompt+tools into
 * (pi-ai dist/utils/transcript.js:6-18,23-26) — the bridge's toBridgeContext
 * folds it back out, so the discriminator sees context.systemPrompt (the
 * SUMMARIZATION_SYSTEM_PROMPT / BUG_SUMMARY_SYSTEM_PROMPT text) and the single
 * user message. Each shape is version-pinned to its source line:
 *
 * - native compaction summary:  PI/dist/core/compaction/compaction.js:400 (SUMMARIZATION_PROMPT)
 *   via utils.js:139 (SUMMARIZATION_SYSTEM_PROMPT)
 * - compaction update:          compaction.js:468 (UPDATE_SUMMARIZATION_PROMPT)
 * - split-turn prefix:          compaction.js:684 (TURN_PREFIX_SUMMARIZATION_PROMPT), wrapped at :752
 * - branch summary:             compaction/branch-summarization.js:153 (BRANCH_SUMMARY_PROMPT), preamble :148
 * - bug report:                 dist/core/bug-report.js:220 (BUG_SUMMARY_INSTRUCTIONS), system prompt :217
 *
 * Ordinary no-cache calls must keep the normal path (full history + tools), and
 * the flag alone must never route.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { isDedicatedSummaryCall } = await import("../src/index.js");

/** pi-ai transcript context: system message carrying pi's summarization system prompt. */
function summaryContext({ system, user, extraMessages = [] } = {}) {
	return {
		systemPrompt: system,
		messages: [
			...(system ? [{ role: "system", content: system }] : []),
			...extraMessages,
			{ role: "user", content: user, timestamp: Date.now() },
		],
	};
}

// Exact system prompts as rendered by installed pi 0.87.1 dist (single trailing
// "Do NOT continue..." paragraph — the discriminator keys on the leading text).
const COMPACT_SYSTEM =
	`You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const BUG_SYSTEM =
	`You are helping a user file a bug report about pi, the coding agent they are talking to. You will be shown the conversation transcript. Write a report for the pi developers describing what the user was doing and what went wrong.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the report.`;

// User prompts as pi renders them: <conversation>…</conversation> + instructions.
const conversation = `user: hi\n\nassistant: hello`;
const COMPACT_PROMPT = `<conversation>\n${conversation}\n</conversation>\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.`;
const COMPACT_UPDATE_PROMPT = `<conversation>\n${conversation}\n</conversation>\n\n<previous-summary>\n## Goal\nold summary\n</previous-summary>\n\nThe messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.`;
const TURN_PREFIX_PROMPT = `# Conversation\n${conversation}\n\n# Instructions\nThe messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.`;
const BRANCH_PROMPT = `<conversation>\n${conversation}\n</conversation>\n\nCreate a structured summary of this conversation branch for context when returning later.`;
const BUG_PROMPT = `<conversation>\n${conversation}\n</conversation>\n\n<user-report>\nsteps went wrong\n</user-report>\n\nWrite the bug report in Markdown with these sections:\n\n## What the user was doing\nOne short paragraph.`;

describe("dedicated summary discriminator", () => {
	it("recognizes each pinned pi 0.87.1 summary shape", () => {
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: COMPACT_SYSTEM, user: COMPACT_PROMPT })), true, "native compaction summary");
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: COMPACT_SYSTEM, user: COMPACT_UPDATE_PROMPT })), true, "compaction update (previous-summary)");
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: COMPACT_SYSTEM, user: TURN_PREFIX_PROMPT })), true, "turn prefix");
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: COMPACT_SYSTEM, user: BRANCH_PROMPT })), true, "branch summary");
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: BUG_SYSTEM, user: BUG_PROMPT })), true, "bug report");
	});

	it("rejects ordinary no-cache traffic even with cacheRetention none implied", () => {
		// First turn: pi's own system prompt, a plain user ask, no history.
		const firstTurn = summaryContext({
			system: "You are Claude Code, an interactive CLI tool…",
			user: "Fix the failing test in src/foo.ts",
		});
		assert.equal(isDedicatedSummaryCall(firstTurn), false);

		// Multi-turn: history present, plain prompt.
		const multiTurn = summaryContext({
			system: "You are Claude Code…",
			user: "continue",
			extraMessages: [
				{ role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: Date.now() },
			],
		});
		assert.equal(isDedicatedSummaryCall(multiTurn), false);

		// Tool-result continuation: last message is a tool result, not a user turn.
		const toolResult = summaryContext({
			system: "You are Claude Code…",
			user: "placeholder", // last message below is the toolResult, not this
		});
		toolResult.messages = [
			{ role: "system", content: "You are Claude Code…" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: Date.now() },
			{ role: "toolResult", content: "file contents", timestamp: Date.now() },
		];
		assert.equal(isDedicatedSummaryCall(toolResult), false);

		// Transcript-tagged text without pi's summarization system prompt:
		// e.g. an extension or user pasting literal <conversation> tags.
		const taggedButNotSummary = summaryContext({
			system: "You are Claude Code…",
			user: "Please summarise <conversation>…</conversation> yourself",
		});
		assert.equal(isDedicatedSummaryCall(taggedButNotSummary), false, "summary-shape text without the summarization system prompt is NOT a dedicated summary call");

		// The system prompt alone is not enough either: ordinary traffic under a
		// spoofed-looking prefix must still not route (defense in depth).
		const sysOnly = summaryContext({
			system: COMPACT_SYSTEM,
			user: "What is the capital of France?",
		});
		assert.equal(isDedicatedSummaryCall(sysOnly), false);
	});

	it("flag alone without a matching shape is NOT the summary path (routing contract)", () => {
		// The provider discriminates on prompt shape; source must not route on
		// options.cacheRetention === "none" as the sole condition.
		const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		// The route guard calls the discriminator; the bare flag match may only
		// produce a debug note, never a route to isolatedStreamFn.
		assert.match(source, /if \(isDedicatedSummaryCall\(context\)\) \{\s*\n[\s\S]{0,400}?return isolatedStreamFn\(model, context, options\);\s*\n\t\}/);
		const flagRoute = source.match(/if \(options\?\.cacheRetention === "none"\) \{([\s\S]*?)\n\t\}/);
		assert.ok(flagRoute, "late no-cache diagnostic block exists");
		assert.ok(
			!/isolatedStreamFn/.test(flagRoute[1]),
			"cacheRetention:\"none\" alone must not route to the isolated summary path",
		);
	});

	it("keys on prompt shape, not on any single marker characters users may type", () => {
		// A user genuinely asking about "the messages above" in plain chat with
		// the normal system prompt must stay ordinary on all dimensions.
		assert.equal(
			isDedicatedSummaryCall(summaryContext({ system: "You are Claude Code…", user: "The messages above are a conversation to summarize; is that true?" })),
			false,
		);
	});

	it("never treats a missing system prompt as a summary", () => {
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: undefined, user: COMPACT_PROMPT })), false);
		assert.equal(isDedicatedSummaryCall(summaryContext({ system: undefined, user: "" })), false);
	});
});
