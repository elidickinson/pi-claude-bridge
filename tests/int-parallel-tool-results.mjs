#!/usr/bin/env node
// Parallel tool calls must survive a session rebuild.
//
// Pi records one message per tool result; repairToolPairing pairs only the ones
// sharing the user message right after their assistant message. When the bridge
// wrote them pi's way, that repair — which runs inside Session.importMessages, so
// it cannot be opted out of — kept only the first and replaced the rest with a
// synthetic "[no tool result recorded]".
// Every rebuild therefore destroyed the output of every parallel tool call.
//
// The unit tests pin the conversion; this pins the part they cannot see: that
// what lands on disk is a shape CC resumes, and that Claude can still read the
// results back out of it.
//
// Requires: ANTHROPIC_API_KEY or CC logged in.

import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSession, repairToolPairing } from "cc-session-io";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { convertPiMessages } from "../src/convert.js";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";
const TOKENS = ["ZEPHYR", "QUARTZ", "MARLIN"];

/** Pi-shaped history: one assistant turn calling read three times, one pi
 *  message per result — exactly what a parallel tool call leaves in pi. */
function piHistoryWithParallelCall() {
	const ids = TOKENS.map((_, i) => `toolu_par${i}`);
	return [
		{ role: "user", content: "Read the three token files." },
		{ role: "assistant", provider: "claude-bridge", content: ids.map((id, i) => ({
			type: "toolCall", id, name: "read", arguments: { path: `token${i}.txt` },
		})) },
		...ids.map((id, i) => ({ role: "toolResult", toolCallId: id, content: `The token in this file is ${TOKENS[i]}.` })),
	];
}

function seedRebuiltSession(sid) {
	const session = createSession({ sessionId: sid, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	const { anthropicMessages } = convertPiMessages(piHistoryWithParallelCall());
	session.importMessages(repairToolPairing(anthropicMessages));
	session.save();
	return session;
}

function toolResultBlocks(jsonlPath) {
	return readFileSync(jsonlPath, "utf8").trim().split("\n")
		.map((l) => JSON.parse(l))
		.filter((r) => Array.isArray(r.message?.content))
		.flatMap((r) => r.message.content.filter((b) => b.type === "tool_result"));
}

test("a rebuilt parallel tool call keeps every result on disk", { timeout: 30_000 }, () => {
	const session = seedRebuiltSession(randomUUID());
	const results = toolResultBlocks(session.jsonlPath);

	assert.equal(results.length, TOKENS.length, `expected ${TOKENS.length} tool_result blocks, got ${results.length}`);
	for (const token of TOKENS) {
		assert.ok(results.some((b) => JSON.stringify(b.content).includes(token)),
			`${token} missing from the rebuilt session — results: ${JSON.stringify(results.map((b) => b.content))}`);
	}
});

test("CC resumes it and Claude can read all three results back", { timeout: 120_000 }, async () => {
	const sid = randomUUID();
	seedRebuiltSession(sid);

	let answer = "";
	for await (const message of query({
		prompt: "List the three tokens from the files you read earlier, uppercase, separated by spaces. Nothing else.",
		options: { resume: sid, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions" },
	})) {
		if (message.type === "assistant") {
			for (const block of message.message?.content ?? []) if (block.type === "text") answer += block.text;
		}
	}

	for (const token of TOKENS) {
		assert.match(answer, new RegExp(token, "i"), `Claude could not see ${token} after the rebuild — answer: ${answer.trim()}`);
	}
});
