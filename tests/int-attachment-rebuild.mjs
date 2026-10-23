#!/usr/bin/env node
// Integration test: an `@file` expansion survives a session rebuild.
//
// Claude Code expands an at-mention itself and stores the file's contents as a
// `type: "attachment"` record in its own session file. pi never sees it, so a
// rebuild from pi's history used to drop the file while keeping the prompt text
// that referred to it — the model silently lost something it was reasoning about.
//
// This drives the real thing rather than the plumbing: it asks Claude Code, over
// a resumed session, for a token that exists *only* inside the carried
// attachment. If the attachment did not reach the rebuilt session, CC cannot
// answer, because the token appears nowhere else in the conversation.
//
// The control matters as much as the assertion. The same rebuild without
// carrying the attachment must fail to produce the token — otherwise the test
// would pass for the wrong reason (CC reading the file off disk, guessing from
// the prompt, or the token leaking through some other path).
//
// Requires: ANTHROPIC_API_KEY or CC logged in.

import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession, deleteSession } from "cc-session-io";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";
// Nothing can infer this from the filename, the prompt, or the file on disk —
// it exists only in the attachment payload the rebuild has to carry.
const TOKEN = "ZORBLAT-4417-QUUX";

const PROMPT = "Review @fixture.txt and remember it.";
const ASK = `What is the build token recorded in the file I attached? Reply with just the token.`;

function attachmentFor(dir) {
	const filePath = join(dir, "fixture.txt");
	const content = `# fixture\nbuild-token: ${TOKEN}\n`;
	writeFileSync(filePath, content);
	return {
		type: "file",
		filename: filePath,
		content: { type: "text", file: { filePath, content } },
	};
}

/** The session as CC left it: prompt, attachment, reply. */
function seedWithAttachment(sid, attachment) {
	const session = createSession({
		sessionId: sid, projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL,
	});
	session.importMessages(
		[
			{ role: "user", content: PROMPT },
			{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
		],
		{ attachments: [{ afterIndex: 0, attachment }] },
	);
	session.save();
	return session;
}

/** What syncSharedSession does on REBUILD, with and without the carry. */
function rebuild(sid, carried) {
	deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
	const session = createSession({
		sessionId: sid, projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL,
	});
	const messages = [
		{ role: "user", content: PROMPT },
		{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
	];
	const placed = placeCarriedAttachments(carried, messages);
	session.importMessages(messages, placed.length ? { attachments: placed } : undefined);
	session.save();
	return { session, placed };
}

async function ask(sid) {
	let out = "";
	for await (const m of query({
		prompt: ASK,
		options: { resume: sid, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions" },
	})) {
		if (m.type === "assistant") {
			for (const block of m.message?.content ?? []) if (block.type === "text") out += block.text;
		}
	}
	return out.trim();
}

test("an @file attachment survives a rebuild and reaches Claude", { timeout: 180_000 }, async () => {
	// The fixture lives outside the repo so CC cannot read it off disk and answer
	// without the attachment — the file path in the prompt is a temp dir.
	const dir = mkdtempSync(join(tmpdir(), "cc-attachment-"));
	const sid = randomUUID();
	try {
		const attachment = attachmentFor(dir);
		const seeded = seedWithAttachment(sid, attachment);
		assert.equal(seeded.attachments.length, 1, "seed did not write the attachment");

		const carried = collectCarriedAttachments(
			openSession({ sessionId: sid, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR }).records,
		);
		assert.equal(carried.length, 1, "collectCarriedAttachments did not find the attachment");

		const { session, placed } = rebuild(sid, carried);
		assert.equal(placed.length, carried.length, "placement dropped the attachment");
		assert.equal(session.attachments.length, 1, "rebuilt session has no attachment");

		const answer = await ask(sid);
		assert.match(answer, new RegExp(TOKEN, "i"),
			`Claude could not see the carried attachment. Answer: ${answer}`);
	} finally {
		deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("control: without the carry, the same rebuild loses it", { timeout: 180_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-attachment-"));
	const sid = randomUUID();
	try {
		seedWithAttachment(sid, attachmentFor(dir));
		const { session } = rebuild(sid, []);
		assert.equal(session.attachments.length, 0, "control rebuild should carry nothing");

		const answer = await ask(sid);
		assert.doesNotMatch(answer, new RegExp(TOKEN, "i"),
			`Control produced the token without the attachment — the positive test proves nothing. Answer: ${answer}`);
	} finally {
		deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
		rmSync(dir, { recursive: true, force: true });
	}
});
