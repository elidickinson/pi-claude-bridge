// Shared definition of what the session write path produces and what "stable"
// means for it, used by diag/replay-write-path.mjs and
// tests/unit-convert-determinism.mjs. Kept in one place so the diagnostic and
// the test cannot drift into disagreeing about the same invariant.

import { readFileSync } from "node:fs";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createSession } from "cc-session-io";
import { importHistory } from "../../src/session-sync.js";
import { nonSystemMessages } from "../../src/transcript.js";

/** Record fields that legitimately differ between two builds of the same
 *  history: identity and clock, none of which reaches the Anthropic prompt. */
export const VOLATILE = new Set(["uuid", "parentUuid", "sessionId", "timestamp", "slug", "requestId"]);

/** Reads a pi session log: one JSON object per line, either the envelope pi
 *  writes (`{"type":"message","message":{…}}`) or a bare pi message. */
export function loadPiMessages(file) {
	const messages = [];
	let skipped = 0;
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		const record = JSON.parse(line);
		if (record.type === "message" && record.message) messages.push(record.message);
		else if (record.role) messages.push(record);
		else skipped++;
	}
	return { messages, skipped };
}

/** A pi session's messages as the provider receives them: pi's convertToLlm,
 *  system messages out. */
export function providerMessages(piMessages) {
	return nonSystemMessages(convertToLlm(piMessages));
}

/** The rebuild's write path (importHistory) reduced to the record content the
 *  prompt cache is keyed on. */
export function transcript(piMessages) {
	const session = createSession({ projectPath: process.cwd() });
	importHistory(session, providerMessages(piMessages));
	return session.records.map((r) => JSON.stringify({
		...Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k))),
		message: { ...r.message, id: undefined },
	}));
}

/** Prefix lengths at which every tool call issued so far has its result.
 *  Truncating mid-turn leaves repairToolPairing no choice but to stand in a
 *  synthetic stub for the results that have not arrived, so only settled
 *  prefixes can be expected to extend cleanly. */
export function settledPrefixes(messages) {
	const lengths = [];
	const pending = new Set();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) if (b.type === "toolCall") pending.add(b.id);
		}
		if (msg.role === "toolResult") pending.delete(msg.toolCallId);
		if (pending.size === 0) lengths.push(i + 1);
	}
	return lengths;
}
