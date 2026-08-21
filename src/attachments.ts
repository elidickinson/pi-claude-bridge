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
// the rebuild reproduces anyway. It also usually hangs off a *tool result* record
// rather than a prompt, which has no position in the ordinal scheme below — on
// real sessions that left 81 of them unresolvable (see
// diag/attachment-coverage.mjs). Half-carrying a kind is worse than not claiming
// it: the ones that slipped through would be an arbitrary subset.
//
// Everything else CC rewrites every turn (`skill_listing`, `task_reminder`,
// `agent_listing_delta`, `mcp_instructions_delta`, …) and loses nothing.
const CONTENT_BEARING = new Set(["file"]);

export type CarriedAttachment = {
	attachment: { type: string; [key: string]: unknown };
	/** Position of the parent among the session's text-bearing user records. */
	userOrdinal: number;
	/** That record's text, to verify the ordinal still points at the same turn. */
	parentText: string;
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
	const ordinalOf = new Map<string, number>();
	const textOf = new Map<string, string>();
	let ordinal = 0;
	const carried: CarriedAttachment[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		const prompt = userPromptText(record);
		if (prompt !== undefined) {
			ordinalOf.set(record.uuid as string, ordinal++);
			textOf.set(record.uuid as string, prompt);
			continue;
		}
		if (record.type !== "attachment") continue;
		const attachmentOf = record.attachment as { type: string; [key: string]: unknown } | undefined;
		// A steer CC drained at a tool boundary. CC records it *only* as this
		// attachment, parented to the tool_result record, with no companion
		// `type: "user"` record — so the loop above never counts it, while pi keeps
		// it as an ordinary user message and `placeCarriedAttachments` does. Left
		// uncounted, every prompt after the first steer is off by one and the text
		// check at placement drops its attachment with nothing but a debug line.
		//
		// Counted here instead of at the parent guard below, because the parent is a
		// tool_result record that has no ordinal of its own to inherit. Seeding
		// `textOf` from the steer's text also lets a run of attachments chain off it,
		// which is what carries an `@file` written inside the steer.
		//
		// `origin` is what separates the two producers of queued_command. CC also
		// injects one when a background Task agent reports back — machine-generated,
		// never in pi's message list, so counting it would shift the ordinals the
		// other way and break exactly what this branch fixes. AskClaude's `full` and
		// `read` modes leave the Agent tool enabled, so that is reachable here, not
		// hypothetical. Across 1673 real records the split is total: every user-side
		// input carries `origin` (kind human, auto-continuation or channel) and no
		// task notification does. Keyed on the field rather than on the notification's
		// text envelope, which is CC-internal and free to change.
		if (attachmentOf?.type === "queued_command" && attachmentOf.origin !== undefined) {
			ordinalOf.set(record.uuid as string, ordinal++);
			textOf.set(record.uuid as string, String(attachmentOf.prompt ?? ""));
			continue;
		}
		const parent = record.parentUuid as string | null;
		// Attachments chain to each other — a run of them hangs off one prompt, and
		// 63 of 179 in real sessions parent to another attachment rather than to a
		// message. Inherit the ordinal so the whole run keys to the prompt that
		// caused it. Recorded for every attachment, not just the ones carried, since
		// a content-bearing one can chain off a `skill_listing` we ignore.
		if (parent === null || !ordinalOf.has(parent)) continue;
		const inherited = ordinalOf.get(parent)!;
		ordinalOf.set(record.uuid as string, inherited);
		textOf.set(record.uuid as string, textOf.get(parent)!);

		if (!attachmentOf || !CONTENT_BEARING.has(attachmentOf.type)) continue;
		carried.push({ attachment: attachmentOf, userOrdinal: inherited, parentText: textOf.get(parent)! });
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

	const attachments: ImportAttachment[] = [];
	const skipped: string[] = [];
	for (const item of carried) {
		const name = String(item.attachment.filename ?? item.attachment.type);
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
