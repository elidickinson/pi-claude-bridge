// Serving a pi history that went back to an earlier turn without a rebuild.
//
// pi's /tree navigation (and anything else that trims history back to an earlier
// turn) leaves a history that is a strict prefix of the one Claude Code's session
// already holds. Rebuilding writes that prefix from pi's history, and any byte the
// rebuild does not reproduce exactly (CC's own attachments, tool argument defaults,
// block shapes) costs the prompt cache for the whole conversation after it. CC can
// instead fork its own session at the turn boundary (`resumeSessionAt` +
// `forkSession`): the kept records are CC's own, so the request matches the cached
// prefix byte for byte.
//
// Deliberately narrow: the cut has to land at the end of a completed turn, and
// every prompt in the kept range has to match CC's record of it. Anything else
// (a branch summary, a cut mid-turn, a steer CC recorded as an attachment) is left
// to the rebuild, which handles every shape.
//
// Extracted from index.ts so tests can import it without activating the extension.

import type { JsonlRecord } from "cc-session-io";
import { messageContentToText } from "./convert.js";

type Msg = { role: string; content?: unknown; timestamp?: number; toolCallId?: string; stopReason?: string };
type Rec = Record<string, unknown>;

/** Identity of a pi message, cheap enough to keep for every message of a long
 *  session: pi stamps each message once and keeps the stamp across navigation. */
export function fingerprint(message: unknown): string {
	const m = message as Msg;
	return `${m.role}:${m.timestamp ?? ""}:${m.toolCallId ?? ""}`;
}

/** Prompt records in CC's session, in order: user records on the main chain
 *  other than tool results, with or without text (an image-only prompt counts). */
function promptRecords(records: readonly JsonlRecord[]): Rec[] {
	return (records as readonly Rec[]).filter((r) => {
		if (r.type !== "user" || r.isSidechain || r.isMeta) return false;
		const content = (r.message as Rec | undefined)?.content;
		return !(Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result"));
	});
}

export type ForkPoint = { uuid: string } | { reason: string };

/**
 * Where to fork CC's session so it holds exactly `prior`, or why it cannot.
 *
 * `synced` fingerprints the history the session was last synced from, which CC's
 * session holds (plus the turn that followed). `prior` must be a strict prefix of
 * it that ends a completed turn and is followed there by a new prompt. The cut is
 * then the chain entry CC recorded just before that prompt: the prompt record's
 * parent, whatever kind of record it is.
 */
export function findForkPoint(prior: readonly unknown[], synced: readonly string[], records: readonly JsonlRecord[]): ForkPoint {
	if (prior.length === 0) return { reason: "empty history" };
	if (prior.length >= synced.length) return { reason: `history (${prior.length}) is not shorter than the synced one (${synced.length})` };
	// Fingerprints carry no content, so they only identify messages pi stamped.
	if (prior.some((m) => (m as Msg).timestamp === undefined)) return { reason: "a kept message has no timestamp" };
	const diverged = prior.findIndex((m, i) => fingerprint(m) !== synced[i]);
	if (diverged !== -1) return { reason: `history diverges from the synced one at message ${diverged}` };
	const last = prior[prior.length - 1] as Msg;
	if (last.role !== "assistant" || last.stopReason === "toolUse") return { reason: `cut is mid-turn (last kept message: ${last.role}${last.stopReason ? `/${last.stopReason}` : ""})` };
	if (!synced[prior.length].startsWith("user:")) return { reason: "the first dropped message is not a prompt" };

	const piPrompts = (prior as Msg[]).filter((m) => m.role === "user");
	// CC's session must hold exactly the synced prompts: one it holds that pi
	// does not (a steer, an AskClaude call, a bridge continue prompt) would shift
	// every prompt after it, and the cut with them.
	const ccPrompts = promptRecords(records);
	const syncedPrompts = synced.filter((f) => f.startsWith("user:")).length;
	if (ccPrompts.length !== syncedPrompts) return { reason: `CC's session has ${ccPrompts.length} prompts, the synced history ${syncedPrompts}` };
	for (const [i, m] of piPrompts.entries()) {
		const ccText = messageContentToText((ccPrompts[i].message as Rec).content as never);
		if (ccText !== messageContentToText(m.content as never)) return { reason: `prompt ${i} differs from CC's record of it` };
	}
	const uuid = ccPrompts[piPrompts.length].parentUuid;
	return typeof uuid === "string" ? { uuid } : { reason: "the next prompt has no parent in CC's chain" };
}
