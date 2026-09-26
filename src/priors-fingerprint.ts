// Content fingerprint for session-sync reuse decisions.
//
// SharedSession sync (src/index.ts syncSharedSession) used to compare message
// COUNT vs cursor, which cannot tell a rewritten or removed prior from a
// matching one (count collision: [recall1,user1] vs [user1,assistant1] both
// len 2 → false REUSE; a context hook injecting text before the last user
// message can hit this case). This module fingerprints the priors the
// rebuild path actually projects: roles, block types, contents, images, tool
// ids/names/arguments/results — everything replay relevant. Deliberately
// EXCLUDED: timestamps, usage/token counts, costs, provider metadata, stop
// reasons — benign re-renders of an unchanged conversation must not churn the
// whole prompt cache.
//
// Mirrors the projection convertPiMessages performs, so content the fingerprint
// calls "in sync" is exactly what a rebuild would have written. Extracted from
// index.ts so unit tests drive it without activating the extension.

import { createHash } from "crypto";
import { PROVIDER_ID } from "./convert.js";

// Bump when the fingerprint shape changes so stale persisted hashes can never
// spuriously match a differently computed one.
const FINGERPRINT_VERSION = "v1";

export interface PriorFingerprint {
	hash: string;
}

// Minimal structural type over pi message shapes — index.ts passes
// Context["messages"], tests pass plain literals. Structural (no index
// signature requirement violated — callers pass Message with a compatible
// subset at the call site).
export type FingerprintMessage = {
	role: string;
	content?: unknown;
	provider?: string;
	toolCallId?: string;
	isError?: boolean;
	[key: string]: unknown;
} |
	Record<string, unknown> & { role: string };

// Stable JSON stringify: object key order must not change the hash.
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Fingerprint pi's projected priors for content-based sync comparison.
 *  Includes everything the conversion into a CC session replays (roles, block
 *  types, text, image data, tool ids/names/args, tool result contents, error
 *  flags, bridge-minted thinking). Excludes timestamps, usage, cost and other
 *  metadata: a metadata-only re-render of an unchanged conversation must not
 *  force a rebuild. */
export function fingerprintProjectedPriors(
	priorMessages: ReadonlyArray<Record<string, any>>,
): PriorFingerprint {
	const h = createHash("sha256");
	h.update(FINGERPRINT_VERSION);
	const lines: string[] = [];
	for (const msg of priorMessages) {
		switch (msg.role) {
			case "user":
				lines.push(`u:${stableStringify(userFingerprint(msg.content))}`);
				break;
			case "assistant": {
				const blocks: unknown[] = [];
				for (const block of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
					switch (block.type) {
						case "text":
							blocks.push({ t: "text", v: block.text ?? "" });
							break;
						case "thinking":
							// Replay-relevant only when the bridge's own provider minted the
							// signature (convertPiMessages refuses to replay others — same
							// condition here, so what is fingerprinted is what is replayed).
							if (msg.provider === PROVIDER_ID && block.thinkingSignature) {
								blocks.push({ t: "thinking", v: block.thinking ?? "", s: block.thinkingSignature });
							}
							break;
						case "toolCall":
							blocks.push({ t: "toolCall", id: block.id ?? "", n: block.name ?? "", a: stableStringify(block.arguments ?? {}) });
							break;
						default:
							// Blocks convertPiMessages drops (with a "[incompatible content
							// omitted]" placeholder preserving the slot). Not replayed
							// verbatim, but their appearance/disappearance changes what a
							// rebuild writes, so their type is fingerprinted.
							blocks.push({ t: `dropped:${block.type}` });
							break;
					}
				}
				lines.push(`a:${stableStringify(blocks)}`);
				break;
			}
			case "toolResult":
				lines.push(`r:${typeof msg.toolCallId === "string" ? msg.toolCallId : ""}:${msg.isError ? 1 : 0}:${stableStringify(toolResultFingerprint(msg.content))}`);
				break;
			default:
				// role "system" is excluded upstream (nonSystemMessages); any other
				// unknown role fingerprints as an opaque entry so its appearance or
				// disappearance is always visible.
				lines.push(`?:${stableStringify(msg.content)}`);
		}
	}
	h.update(lines.join("\n"));
	return { hash: h.digest("hex") };
}

// Canonical form of tool result content (images included by data, in arrival
// order — the shape toolResultToMcpContent hands the session).
function toolResultFingerprint(content: unknown): unknown {
	if (typeof content === "string") return [{ t: "text", v: content }];
	if (!Array.isArray(content)) return [{ t: "text", v: "" }];
	const parts: unknown[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && block.text) parts.push({ t: "text", v: block.text });
		else if (block.type === "image" && block.data && block.mimeType) parts.push({ t: "image", m: block.mimeType, d: block.data });
		else parts.push({ t: `dropped:${block.type}` });
	}
	return parts;
}

// Canonical form of user content (string or blocks), mirroring convertPiMessages'
// user branch.
function userFingerprint(content: unknown): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[empty]";
	const parts: unknown[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && block.text) parts.push({ t: "text", v: block.text });
		else if (block.type === "image" && block.data && block.mimeType) parts.push({ t: "image", m: block.mimeType, d: block.data });
	}
	return parts.length ? parts : "[image]";
}
