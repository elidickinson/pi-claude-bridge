// Shared definition of what the session write path produces and what "stable"
// means for it, used by diag/replay-write-path.mjs and
// tests/unit-convert-determinism.mjs. Kept in one place so the diagnostic and
// the test cannot drift into disagreeing about the same invariant.

import { readFileSync } from "node:fs";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createSession } from "cc-session-io";
import { importHistory } from "../../src/session-sync.js";
import { nonSystemMessages } from "../../src/transcript.js";
import { PROVIDER_ID } from "../../src/convert.js";

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

/** True if `msg` carries a thinking block convertPiMessages cannot replay —
 *  minted by a provider other than claude-bridge, or ours but signature-less
 *  because the stream was cut mid-thought. Mirrors the condition in
 *  convertPiMessages that drops such a message outright when it is the
 *  latest assistant message, since a prefix boundary landing there is
 *  exactly the case that condition makes position-dependent. */
function hasUnreplayableThinking(msg) {
	return Array.isArray(msg.content) && msg.content.some((b) =>
		b.type === "thinking" && !(msg.provider === PROVIDER_ID && b.thinkingSignature));
}

/** Prefix lengths at which every tool call issued so far has its result.
 *  Truncating mid-turn leaves repairToolPairing no choice but to stand in a
 *  synthetic stub for the results that have not arrived, so only settled
 *  prefixes can be expected to extend cleanly.
 *
 *  Also excludes a boundary that lands on an unreplayable-thinking assistant
 *  message (see hasUnreplayableThinking): convertPiMessages converts that
 *  exact message differently depending on whether a later assistant message
 *  exists in the array it's given — dropped when it's the latest, kept
 *  (block filtered, placeholder standing in) once a later one appears. A
 *  boundary ending there is the one "settled" position that is not stable to
 *  extend, since extending it past the message *into* its own un-filtered
 *  territory is the point of the test this feeds. */
export function settledPrefixes(messages) {
	const lengths = [];
	const pending = new Set();
	let lastAssistantUnreplayable = false;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) if (b.type === "toolCall") pending.add(b.id);
		}
		if (msg.role === "assistant") lastAssistantUnreplayable = hasUnreplayableThinking(msg);
		if (msg.role === "toolResult") pending.delete(msg.toolCallId);
		if (pending.size === 0 && !lastAssistantUnreplayable) lengths.push(i + 1);
	}
	return lengths;
}
