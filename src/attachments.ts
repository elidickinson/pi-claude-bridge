// Carrying Claude Code's own attachments across a session rebuild.
//
// CC expands an `@file` mention itself — pi passes `@` through untouched — and
// writes the expansion as a `type: "attachment"` record in its session file. pi
// never sees it, so rebuilding a session from pi's history drops the file while
// keeping the prompt text that referred to it: the model silently loses
// something it was reasoning about, with nothing logged.
//
// Extracted from index.ts so tests can import it without activating the extension.

import type { JsonlRecord, ImportAttachment } from "cc-session-io";
import { messageContentToText, sanitizeToolId } from "./convert.js";

// `@file` expansions anchor to the prompt that mentioned them (the only thing pi
// genuinely never sees, so a rebuild is the only chance to keep them);
// `edited_text_file` snapshots anchor to the tool result that produced them.
//
// `edited_text_file` used to be dropped entirely: CC writes one after editing a
// file, usually hanging off a *tool result* record rather than a prompt, which
// had no position in the ordinal scheme — on real sessions that left 81 of them
// unresolvable (see diag/attachment-coverage.mjs). The edit survives the rebuild
// as a tool call + result, but the file snapshot CC recorded afterwards does not,
// so it is now carried through a tool-result anchor instead (see the anchor
// types below). Only that kind anchors to tool results; an `@file` expansion
// never does, and keeping its path byte-identical keeps the diag-verified
// prompt scheme untouched.
//
// Everything else CC rewrites every turn (`skill_listing`, `task_reminder`,
// `agent_listing_delta`, `mcp_instructions_delta`, …) and loses nothing.
const CONTENT_BEARING = new Set(["file", "edited_text_file"]);

/** Where an attachment's parent chain terminates. */
type Anchor =
	| { kind: "prompt"; ordinal: number; text: string }
	// The tool result that produced the attachment: ids and content identity, so a
	// rebuild can find the same result (by id, translated through sanitization)
	// and reject the match if the result changed.
	| { kind: "tool"; toolUseId: string; resultText: string; isError: boolean };

export type CarriedAttachment = {
	attachment: { type: string; [key: string]: unknown };
	/** Position of the parent among the session's text-bearing user records. */
	userOrdinal?: number;
	/** That record's text, to verify the ordinal still points at the same turn. */
	parentText?: string;
	/** tool_use_id of the tool result the attachment was recorded after. */
	toolUseId?: string;
	/** Flattened result content, to verify the id still points at the same result. */
	resultText?: string;
	isError?: boolean;
};

type Rec = Record<string, unknown>;

/** A user record holding a prompt, as opposed to one holding tool results. */
function userPromptText(record: Rec): string | undefined {
	if (record.type !== "user") return undefined;
	const content = (record.message as Rec | undefined)?.content;
	if (Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result")) return undefined;
	const text = messageContentToText(content as never);
	return text ? text : undefined;
}

/** A tool-result user record's anchor, when it holds exactly one result.
 *
 *  Claude Code's live writer splits a turn across records one result per record
 *  (tests/int-cc-contracts.mjs pins that), so anything else is a shape this
 *  cannot attribute to one id — left unanchored, which drops the attachment
 *  rather than guessing which of several results produced it.
 */
function toolResultAnchor(record: Rec): Anchor | undefined {
	if (record.type !== "user") return undefined;
	const content = (record.message as Rec | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const results = content.filter((b) => (b as Rec)?.type === "tool_result");
	if (results.length !== 1) return undefined;
	const block = results[0] as Rec;
	const toolUseId = block.tool_use_id;
	if (typeof toolUseId !== "string" || !toolUseId) return undefined;
	return {
		kind: "tool",
		toolUseId,
		// Flattened the same way the rebuilt tool_result flattens pi's content, so
		// the two sides compare equal when the history is unchanged.
		resultText: messageContentToText(block.content as never),
		isError: block.is_error === true,
	};
}

/**
 * Content-bearing attachments in a session, each tagged with where its parent
 * sits among the text-bearing user records.
 *
 * The ordinal is the mapping key rather than the record index: a rebuild does not
 * reproduce the old record list one-for-one — `importMessages` splits a message
 * carrying tool results into two records, and CC appends records of its own — but
 * the sequence of user prompts is the same conversation either way.
 *
 * Attachments also chain to one another, so an anchor is resolved transitively up
 * the parent links until it reaches a prompt or a tool result.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
	const anchorOf = new Map<string, Anchor>();
	let ordinal = 0;
	const carried: CarriedAttachment[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		const prompt = userPromptText(record);
		if (prompt !== undefined) {
			anchorOf.set(record.uuid as string, { kind: "prompt", ordinal: ordinal++, text: prompt });
			continue;
		}
		const tool = toolResultAnchor(record);
		if (tool) {
			anchorOf.set(record.uuid as string, tool);
			continue;
		}
		if (record.type !== "attachment") continue;
		const parent = record.parentUuid as string | null;
		// Attachments chain to each other — a run of them hangs off one record, and
		// 63 of 179 in real sessions parent to another attachment rather than to a
		// message. Inherit the anchor so the whole run keys to the record that
		// caused it. Recorded for every attachment, not just the ones carried, since
		// a content-bearing one can chain off a `skill_listing` we ignore.
		if (parent === null || !anchorOf.has(parent)) continue;
		const anchor = anchorOf.get(parent)!;
		anchorOf.set(record.uuid as string, anchor);

		const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
		if (!attachment || !CONTENT_BEARING.has(attachment.type)) continue;
		// A tool-result anchor is only meaningful for kinds CC actually records
		// after a tool runs; everything else keeps the prompt scheme untouched.
		if (anchor.kind === "tool" && attachment.type !== "edited_text_file") continue;
		carried.push(
			anchor.kind === "prompt"
				? { attachment, userOrdinal: anchor.ordinal, parentText: anchor.text }
				: { attachment, toolUseId: anchor.toolUseId, resultText: anchor.resultText, isError: anchor.isError },
		);
	}
	return carried;
}

/**
 * Resolve each carried attachment to a position in the array about to be
 * imported — the messages *after* conversion and repair, since that is the index
 * space `importMessages` reads. Repair is idempotent, so an already-repaired array
 * passes through its second run unchanged and the indices stay valid.
 *
 * Deliberately conservative: attaching a file to the wrong turn tells the model it
 * saw something at a point it did not, which is worse than the loss this exists to
 * prevent. So the ordinal has to land on a prompt whose text still matches, and a
 * tool-anchored attachment has to land on a tool result with the same id and
 * content; any disagreement is reported and dropped rather than approximated.
 *
 * `sanitizedIds` is the id map convertPiMessages built (pi toolCallId → the id
 * written into the rebuilt transcript). A tool-anchored attachment's recorded
 * tool_use_id is a pre-rebuild id, so it goes through the same map before the
 * rebuilt tool results can be searched for it — and only through it: the anchor
 * matches the rebuild, never a filename or any other proxy.
 */
export function placeCarriedAttachments(
	carried: readonly CarriedAttachment[],
	messages: readonly { role: string; content: unknown }[],
	sanitizedIds?: ReadonlyMap<string, string>,
): { attachments: ImportAttachment[]; skipped: string[] } {
	const prompts: { index: number; text: string }[] = [];
	messages.forEach((msg, index) => {
		if (msg.role !== "user") return;
		if (Array.isArray(msg.content) && msg.content.some((b) => (b as Rec)?.type === "tool_result")) return;
		const text = messageContentToText(msg.content as never);
		if (text) prompts.push({ index, text });
	});

	// Distinct pi tool calls can sanitize to the same id (sanitizeToolId collapses
	// e.g. "a.b" and "a_b"); such a rewritten id names two results at once, so any
	// anchor through it is ambiguous and is dropped.
	const sanitizedCollisions = new Map<string, number>();
	for (const clean of sanitizedIds?.values() ?? []) {
		sanitizedCollisions.set(clean, (sanitizedCollisions.get(clean) ?? 0) + 1);
	}

	const attachments: ImportAttachment[] = [];
	const skipped: string[] = [];
	for (const item of carried) {
		const name = String(item.attachment.filename ?? item.attachment.type);
		if (item.toolUseId !== undefined) {
			const placed = placeToolAnchored(item, messages, sanitizedIds, sanitizedCollisions.get(sanitizeToolId(item.toolUseId, new Map())) ?? 0);
			if (typeof placed === "string") {
				skipped.push(`${name}: ${placed}`);
			} else {
				attachments.push({ afterIndex: placed, attachment: item.attachment });
			}
			continue;
		}
		const candidate = prompts[item.userOrdinal!];
		if (!candidate) {
			skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`);
			continue;
		}
		if (candidate.text !== item.parentText) {
			skipped.push(`${name}: prompt #${item.userOrdinal} changed`);
			continue;
		}
		attachments.push({ afterIndex: candidate.index, attachment: item.attachment });
	}
	return { attachments, skipped };
}

/** Resolve a tool-result anchor to a message index, or a reason it was dropped.
 *
 *  Parallel tool results merge into one imported message (convertPiMessages), so
 *  several anchors can land after that one message: the rebuild keeps every
 *  result and every attachment, but not CC's original interleaving of records —
 *  an acceptable loss, since the merge itself already flattens it.
 */
function placeToolAnchored(
	item: CarriedAttachment,
	messages: readonly { role: string; content: unknown }[],
	sanitizedIds: ReadonlyMap<string, string> | undefined,
	collisions: number,
): number | string {
	// The recorded id must belong to a tool call pi's history still carries; a
	// pruned or rewritten edit has no anchor left to attach to.
	const sanitized = sanitizedIds?.get(item.toolUseId!);
	if (sanitized === undefined) return `tool call ${item.toolUseId} is no longer in history`;
	if (collisions > 1) return `tool call ${item.toolUseId}: sanitized id "${sanitized}" is ambiguous`;

	const matches: { index: number; text: string; isError: boolean }[] = [];
	messages.forEach((msg, index) => {
		if (!Array.isArray(msg.content)) return;
		for (const b of msg.content as Rec[]) {
			if (b?.type !== "tool_result" || b.tool_use_id !== sanitized) continue;
			matches.push({ index, text: messageContentToText(b.content as never), isError: b.is_error === true });
		}
	});
	if (matches.length === 0) return `tool result for ${item.toolUseId} is no longer in history`;
	if (matches.length > 1) return `tool result for ${item.toolUseId} appears ${matches.length} times`;
	const found = matches[0];
	// The history was rewritten under the same id — drop rather than present a
	// snapshot of a file the recorded edit never produced.
	if (found.text !== item.resultText) return `tool result for ${item.toolUseId} changed`;
	if (found.isError !== (item.isError === true)) return `tool result for ${item.toolUseId} changed`;
	return found.index;
}
