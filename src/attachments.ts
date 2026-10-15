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
import { messageContentToText } from "./convert.js";

// Only `@file` expansions are carried. They are the one thing pi genuinely never
// sees, so a rebuild is the only chance to keep them.
//
// `edited_text_file` is deliberately excluded even though it also carries file
// content. CC writes one after editing a file, and the edit itself is already in
// pi's history as a tool call and its result, so the attachment duplicates context
// the rebuild reproduces anyway.
//
// Everything else CC rewrites every turn (`skill_listing`, `task_reminder`,
// `agent_listing_delta`, `mcp_instructions_delta`, …) and loses nothing.
const CONTENT_BEARING = new Set(["file"]);

// Session-start context CC attaches once, to the first prompt, and renders into
// that prompt's request (the `<system-reminder>` context block and the
// `# Environment` system message, which carries the history cache breakpoint).
// CC does NOT rewrite these every turn: dropped on a rebuild, CC re-attaches them
// to the NEWEST prompt instead, so the rebuilt request differs from the cached
// one at messages[0] and the whole history is re-written to the prompt cache.
// Carried at their original position, the rebuilt request keeps the same message
// prefix (text-identical; one message may switch list/string form, as it does on
// any live turn) and the history is read from cache: measured 26,417 read / 875
// written vs 12,722 / 14,423 without, on the same rebuild.
//
// `instructions` is the memory/instruction-file block (auto-memory MEMORY.md, and
// project instruction files when CC loads them). It only exists when the folder has
// such files, so a test folder without a memory dir never exercises it; dropped, it
// moves to the newest prompt like the rest. Carrying replays exactly what the model
// saw at session start. If the file changes mid-session CC appends a fresh copy to
// a later prompt, as it does in a session that was never rebuilt.
const SESSION_CONTEXT = new Set([
	"environment",
	"model",
	"output_style_instructions",
	"total_tokens_reminder",
	"output_style",
	"session_context",
	"date",
	"credential_org",
	"instructions",
]);

/** Where a carried attachment hangs: after a prompt, or after a tool-result record. */
type Anchor =
	/** Position among the session's text-bearing user records, and that record's
	 *  text, to verify the ordinal still points at the same turn. */
	| { userOrdinal: number; parentText: string }
	/** The first tool call the parent record answers. Claude Code hangs per-turn
	 *  context (`total_tokens_reminder`) off tool results too, and a tool_use id
	 *  names that record exactly, where an ordinal could not. */
	| { toolUseId: string };

export type CarriedAttachment = Anchor & { attachment: { type: string; [key: string]: unknown } };

type Rec = Record<string, unknown>;

/** A user record holding a prompt, as opposed to one holding tool results. */
function userPromptText(record: Rec): string | undefined {
	if (record.type !== "user") return undefined;
	const content = (record.message as Rec | undefined)?.content;
	if (Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result")) return undefined;
	const text = messageContentToText(content as never);
	return text ? text : undefined;
}

/** The first tool_use id a message answers, if it holds tool results. */
function firstToolResultId(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const block = content.find((b) => (b as Rec)?.type === "tool_result") as Rec | undefined;
	return typeof block?.tool_use_id === "string" ? block.tool_use_id : undefined;
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
 * Attachments also chain to one another, so an ordinal is resolved transitively up
 * the parent links until it reaches a prompt. Most real attachments are
 * `edited_text_file` records CC writes after editing a file, which have nothing to
 * do with at-mentions; only their position in the conversation matters here.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
	const anchorOf = new Map<string, Anchor>();
	let ordinal = 0;
	const carried: CarriedAttachment[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		const prompt = userPromptText(record);
		if (prompt !== undefined) {
			anchorOf.set(record.uuid as string, { userOrdinal: ordinal++, parentText: prompt });
			continue;
		}
		if (record.type === "user") {
			const toolUseId = firstToolResultId((record.message as Rec | undefined)?.content);
			if (toolUseId !== undefined) anchorOf.set(record.uuid as string, { toolUseId });
			continue;
		}
		if (record.type !== "attachment") continue;
		const parent = record.parentUuid as string | null;
		// Attachments chain to each other — a run of them hangs off one prompt, and
		// 63 of 179 in real sessions parent to another attachment rather than to a
		// message. Inherit the anchor so the whole run keys to the record that
		// caused it. Recorded for every attachment, not just the ones carried, since
		// a content-bearing one can chain off a `skill_listing` we ignore.
		if (parent === null || !anchorOf.has(parent)) continue;
		const inherited = anchorOf.get(parent)!;
		anchorOf.set(record.uuid as string, inherited);

		const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
		if (!attachment || !(CONTENT_BEARING.has(attachment.type) || SESSION_CONTEXT.has(attachment.type))) continue;
		carried.push({ ...inherited, attachment });
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
 * prevent. So the ordinal has to land on a prompt whose text still matches; any
 * disagreement is reported and dropped rather than approximated.
 */
export function placeCarriedAttachments(
	carried: readonly CarriedAttachment[],
	messages: readonly { role: string; content: unknown }[],
): { attachments: ImportAttachment[]; skipped: string[] } {
	const prompts: { index: number; text: string }[] = [];
	messages.forEach((msg, index) => {
		if (msg.role !== "user") return;
		if (Array.isArray(msg.content) && msg.content.some((b) => (b as Rec)?.type === "tool_result")) return;
		const text = messageContentToText(msg.content as never);
		if (text) prompts.push({ index, text });
	});

	const toolResultIndex = new Map<string, number>();
	messages.forEach((msg, index) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) return;
		for (const block of msg.content as Rec[]) {
			if (block?.type === "tool_result" && typeof block.tool_use_id === "string") toolResultIndex.set(block.tool_use_id, index);
		}
	});

	const attachments: ImportAttachment[] = [];
	const skipped: string[] = [];
	for (const item of carried) {
		const name = String(item.attachment.filename ?? item.attachment.type);
		if ("toolUseId" in item) {
			const index = toolResultIndex.get(item.toolUseId);
			if (index === undefined) skipped.push(`${name}: result of ${item.toolUseId} is no longer in history`);
			else attachments.push({ afterIndex: index, attachment: item.attachment });
			continue;
		}
		const candidate = prompts[item.userOrdinal];
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
