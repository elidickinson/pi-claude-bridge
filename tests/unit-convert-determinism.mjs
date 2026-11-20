#!/usr/bin/env node
// Two invariants on the session write path (importHistory: convert, repair,
// write records):
//
//   1. Determinism. The same pi history always produces the same transcript
//      content. Only identity and clock fields may differ between builds.
//   2. Prefix stability. A transcript built from a longer history is a strict
//      content-extension of the one built from a shorter history. Anthropic's
//      prompt cache is keyed on exact prompt-prefix bytes, so any mid-history
//      mutation re-caches everything after it on the next rebuild — and means
//      the same pi message converted differently depending on what followed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../src/convert.js";
// Shared with diag/replay-write-path.mjs so the diagnostic and this test cannot
// drift into disagreeing about what "stable" means.
import { settledPrefixes, transcript } from "../diag/lib/write-path.mjs";

function assertPrefix(shorter, longer, label) {
	for (let i = 0; i < shorter.length; i++) {
		assert.equal(longer[i], shorter[i], `${label}: record ${i} of ${shorter.length} diverged`);
	}
}

// A real 310-message pi session with its content scrubbed: text bodies became
// `t<n>:<length>` placeholders and tool arguments `a<n>:<length>` ones, since the
// session came from a private project. Structure — roles, block types, tool ids,
// providers, thinking signatures, parallel calls — is verbatim, and structure is
// all these invariants read.
const corpus = readFileSync(fileURLToPath(new URL("./fixtures/pi-history-310.jsonl", import.meta.url)), "utf-8")
	.split("\n").filter(Boolean).map((line) => JSON.parse(line));

// Parallel calls, a steer landing between their results, an image result, an
// error result, empty content, exotic tool ids, thinking with and without a
// signature, and thinking from providers whose signatures we may not replay.
const exotic = [
	{ role: "user", content: "start" },
	{ role: "assistant", provider: "claude-bridge", content: [
		{ type: "thinking", thinking: "planning", thinkingSignature: "sigA" },
		{ type: "text", text: "reading two files" },
		{ type: "toolCall", id: "functions.read:0", name: "read", arguments: { path: "a" } },
		{ type: "toolCall", id: "functions.read:1", name: "read", arguments: { path: "b" } },
	] },
	{ role: "toolResult", toolCallId: "functions.read:0", content: "body a" },
	{ role: "user", content: "actually also check c" },
	{ role: "toolResult", toolCallId: "functions.read:1", content: [
		{ type: "text", text: "shot" },
		{ type: "image", data: "BASE64", mimeType: "image/png" },
	] },
	{ role: "assistant", provider: "openrouter", content: [
		{ type: "thinking", thinking: "foreign", thinkingSignature: "sigB" },
		{ type: "toolCall", id: "tool call#2@x", name: "my_custom_tool", arguments: {} },
	] },
	{ role: "toolResult", toolCallId: "tool call#2@x", content: "", isError: true },
	{ role: "assistant", provider: "claude-bridge", content: [{ type: "thinking", thinking: "unsigned" }] },
	{ role: "user", content: "" },
	{ role: "user", content: [{ type: "image", data: "IMG", mimeType: "image/jpeg" }] },
	{ role: "assistant", provider: "claude-bridge", content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { cmd: "ls" } }] },
	{ role: "toolResult", toolCallId: "t9", content: [{ type: "document" }] },
	{ role: "assistant", provider: "claude-bridge", content: [{ type: "text", text: "done" }] },
];

describe("conversion is deterministic", () => {
	it("a real 310-message session converts identically twice", () => {
		assert.deepEqual(transcript(corpus), transcript(corpus));
	});

	it("parallel calls, images, errors and thinking blocks convert identically twice", () => {
		assert.deepEqual(transcript(exotic), transcript(exotic));
	});
});

describe("rebuilds extend the transcript instead of rewriting it", () => {
	// Comparing every settled prefix against the full transcript also settles the
	// pairwise claim: two prefixes of the same string are prefixes of each other.
	it("every settled prefix of a real session is a prefix of the full rebuild", () => {
		const full = transcript(corpus);
		const lengths = settledPrefixes(corpus);
		assert.ok(lengths.length > 100, `expected many settled prefixes, got ${lengths.length}`);
		for (const n of lengths) assertPrefix(transcript(corpus.slice(0, n)), full, `history[0..${n}]`);
	});

	it("a settled prefix survives every longer history, mid-turn truncation included", () => {
		for (const n of settledPrefixes(exotic)) {
			const shorter = transcript(exotic.slice(0, n));
			for (let m = n + 1; m <= exotic.length; m++) {
				assertPrefix(shorter, transcript(exotic.slice(0, m)), `exotic[0..${n}] vs [0..${m}]`);
			}
		}
	});
});

// diag/replay-write-path.mjs feeds raw pi session logs, which hold system and
// session-only roles the provider never receives as such.
it("transcript() takes pi session messages the way the provider receives them", () => {
	const records = transcript([
		{ role: "system", content: "rules", timestamp: 1 },
		{ role: "custom", customType: "note", content: "from an extension", display: true, timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 1 },
	]).map((record) => JSON.parse(record).message.content);
	assert.deepEqual(records, [[{ type: "text", text: "from an extension" }], "hi"]);
});

it("an empty tool result converts to Claude Code's no-output placeholder", () => {
	const { anthropicMessages } = convertPiMessages([
		{ role: "user", content: "go" },
		{ role: "assistant", provider: "openrouter", content: [
			{ type: "toolCall", id: "t1", name: "sudo_exec", arguments: {} },
			{ type: "toolCall", id: "t2", name: "touch", arguments: {} },
		] },
		{ role: "toolResult", toolCallId: "t1", toolName: "sudo_exec", content: [{ type: "text", text: "" }], isError: true },
		{ role: "toolResult", toolCallId: "t2", toolName: "touch", content: " " },
	]);
	assert.deepEqual(anthropicMessages[2].content, [
		{ type: "tool_result", tool_use_id: "t1", content: "Command failed with no output", is_error: true },
		{ type: "tool_result", tool_use_id: "t2", content: "(mcp__custom-tools__touch completed with no output)" },
	]);
});

// Prefix stability is satisfiable by a conversion that loses content
// consistently, so pin the content too: the pre-ff60313c conversion passed both
// invariants above while dropping every parallel result past the first.
it("a real session round-trips with every tool result intact", () => {
	const blocks = repairToolPairing(convertPiMessages(corpus).anthropicMessages)
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((b) => b.type === "tool_result");
	const expected = corpus.filter((m) => m.role === "toolResult");

	assert.equal(blocks.length, expected.length);
	assert.deepEqual(blocks.map((b) => b.tool_use_id), expected.map((m) => m.toolCallId));
	assert.deepEqual(blocks.filter((b) => String(b.content).includes("no tool result recorded")), []);
});
