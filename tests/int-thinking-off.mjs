#!/usr/bin/env node
// End-to-end check that the bridge's thinking options make pi's slider
// authoritative over ~/.claude/settings.json in BOTH directions:
//   - reasoning=off suppresses thinking even when settings force it on
//     (alwaysThinkingEnabled: true)
//   - reasoning=high produces thinking even when settings disable it
//     (alwaysThinkingEnabled: false)
// Without explicit thinking flags, settings win in each direction (verified
// live while developing this feature) — these tests pin the fix.
//
// Calls the Claude Agent SDK `query()` directly with the bridge's option
// shape (effort + thinking from resolveThinking) plus adversarial inline
// `--settings`, then inspects the streamed assistant content for `thinking`
// blocks. This is the only layer that proves CC honors the flags — the bridge
// log only shows what we passed in, not what ran.
//
// off-direction is deterministic (disabled => no thinking blocks). The
// on-direction uses a reasoning-heavy prompt; a model can in principle skip
// thinking on a trivial prompt, but long multiplication reliably triggers it.
//
// Requires: ANTHROPIC_API_KEY or CC logged in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveThinking } from "../src/models.js";

const CWD = process.cwd();
const MODEL = "claude-opus-4-7";
const REASONING_PROMPT = "Compute 247 × 389 by hand using long multiplication, showing each partial product. Then verify the result a second way (for example 247 × 400 − 247 × 11) and confirm both match.";
const TIMEOUT = 120_000;

function optionsFor(reasoning, settings) {
	const { effort, thinking } = resolveThinking(MODEL, reasoning, "high", { xhigh: "xhigh" });
	return {
		cwd: CWD,
		env: { ...process.env, DISABLE_AUTO_COMPACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0" },
		permissionMode: "bypassPermissions",
		model: MODEL,
		systemPrompt: { type: "preset", preset: "claude_code" },
		extraArgs: { "strict-mcp-config": null },
		...(effort ? { effort } : {}),
		...(thinking ? { thinking } : {}),
		...(settings ? { settings: JSON.stringify(settings) } : {}),
	};
}

async function countThinkingBlocks(reasoning, settings) {
	let thinkingBlocks = 0;
	let text = "";
	const q = query({ prompt: REASONING_PROMPT, options: optionsFor(reasoning, settings) });
	for await (const m of q) {
		if (m.type !== "assistant") continue;
		for (const block of m.message?.content ?? []) {
			if (block.type === "thinking") thinkingBlocks++;
			else if (block.type === "text") text += block.text;
		}
	}
	return { thinkingBlocks, text: text.trim() };
}

test("reasoning=off emits no thinking blocks despite alwaysThinkingEnabled:true", { timeout: TIMEOUT }, async () => {
	const { thinkingBlocks, text } = await countThinkingBlocks("off", { alwaysThinkingEnabled: true });
	assert.equal(thinkingBlocks, 0, `expected no thinking blocks with reasoning=off, got ${thinkingBlocks}`);
	assert.ok(text.length > 0, "expected a text response");
});

test("reasoning=high emits thinking blocks despite alwaysThinkingEnabled:false", { timeout: TIMEOUT }, async () => {
	const { thinkingBlocks, text } = await countThinkingBlocks("high", { alwaysThinkingEnabled: false });
	assert.ok(thinkingBlocks > 0, `expected thinking blocks with reasoning=high, got ${thinkingBlocks} (text: ${text.slice(0, 80)})`);
});
