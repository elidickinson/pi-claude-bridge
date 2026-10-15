// Carrying Claude Code's own tool_result content across a session rebuild.
//
// For some results, Claude Code does not send the MCP content the bridge returned.
// It writes the content it actually sends into its session file, and a rebuild
// regenerates the result from pi's history instead, so the rebuilt request differs
// from the cached one at the first such result and everything after it is
// re-written to the prompt cache:
//
// - Image results gain a trailing `[Image: source: <session dir>/tool-results/…]`
//   text block naming the copy CC saved.
// - Large results are replaced by a notice naming a file CC saved the full output
//   to: a `<persisted-output>` preview, or an `Error: result (…) exceeds maximum
//   allowed tokens. Output has been saved to …` instruction. Rebuilding those from
//   pi's full result also re-inflates the request past what pi's usage tracking
//   knows about (#156).
//
// So the rebuild reuses CC's content, keyed by tool_use_id, but only where it is
// provably derived from the result pi still holds: an extension may have rewritten
// a result in pi's history since, and that rewrite must win.
//
// Extracted from index.ts so tests can import it without activating the extension.

import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { JsonlRecord } from "cc-session-io";

type Rec = Record<string, unknown>;

/** A tool result as Claude Code sent it, and the content pi's copy must have for
 *  CC's version to stand in for it. */
export type CarriedToolResult = { content: unknown; isError: boolean; sources: Canonical[] };

/** Block-level identity of a result, ignoring wire shape (string vs one text block). */
type Canonical = string;

const IMAGE_SOURCE = /^\[Image: source: [^\n]*\]$/;
const PERSISTED = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: ([^\n]+)\n/;
const OVERSIZED = /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to ([^\n]+?)\.\n/;

function canonicalBlocks(content: unknown): Canonical | undefined {
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (!Array.isArray(blocks)) return undefined;
	const out: unknown[] = [];
	for (const raw of blocks as Rec[]) {
		if (raw?.type === "text" && typeof raw.text === "string") out.push(["text", raw.text]);
		else if (raw?.type === "image") {
			// Anthropic form in requests, MCP form ({ data, mimeType }) in a saved file.
			const source = raw.source as Rec | undefined;
			out.push(["image", source?.media_type ?? raw.mimeType, source?.data ?? raw.data]);
		} else return undefined;
	}
	return JSON.stringify(out);
}

// Saved outputs past this are not read: pi's full result is the fallback.
const MAX_SAVED_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Read a saved full output, but only a regular file in some session's
 * `tool-results` dir under this project, with no symlink on the way. The path
 * comes from record text, and a tool result pi passed through could imitate a
 * notice naming any file.
 */
export function readSavedOutput(projectDir: string, path: string): string | undefined {
	const root = resolve(projectDir);
	const parts = relative(root, resolve(path)).split(sep);
	if (parts.length !== 3 || parts[0] === ".." || parts[1] !== "tool-results") return undefined;
	const sessionDir = lstatSync(join(root, parts[0]), { throwIfNoEntry: false });
	const toolResults = lstatSync(join(root, parts[0], parts[1]), { throwIfNoEntry: false });
	const file = lstatSync(join(root, ...parts), { throwIfNoEntry: false });
	if (!sessionDir?.isDirectory() || !toolResults?.isDirectory() || !file?.isFile()) return undefined;
	if (file.size > MAX_SAVED_OUTPUT_BYTES) return undefined;
	return readFileSync(join(root, ...parts), "utf8");
}

/** What a saved full-output file says the result was. CC saves a block array as
 *  JSON under a `.json` name (the `<persisted-output>` form) and text otherwise. */
function savedOutputSource(path: string, text: string): Canonical | undefined {
	if (!path.endsWith(".json")) return canonicalBlocks(text);
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? canonicalBlocks(parsed) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Tool results in a session, keyed by tool_use_id, where CC's content differs from
 * the result it was derived from in a way a rebuild cannot reproduce.
 *
 * A result whose saved file is gone is left out: its notice would send the model
 * to a file that no longer exists, and pi's full result is the better fallback.
 */
export function collectCarriedToolResults(
	records: readonly JsonlRecord[],
	projectDir: string,
): Map<string, CarriedToolResult> {
	const readFile = (path: string) => readSavedOutput(projectDir, path);
	const carried = new Map<string, CarriedToolResult>();
	for (const raw of records) {
		const record = raw as Rec;
		if (record.type !== "user" || record.isSidechain) continue;
		const content = (record.message as Rec | undefined)?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Rec[]) {
			if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const sources = sourcesOf(block.content, readFile);
			if (!sources.length) continue;
			carried.set(block.tool_use_id, { content: block.content, isError: block.is_error === true, sources });
		}
	}
	return carried;
}

function sourcesOf(content: unknown, readFile: (path: string) => string | undefined): Canonical[] {
	if (typeof content === "string") {
		const saved = PERSISTED.exec(content)?.[1] ?? OVERSIZED.exec(content)?.[1];
		if (saved === undefined) return [];
		try {
			const text = readFile(saved);
			const source = text === undefined ? undefined : savedOutputSource(saved, text);
			return source === undefined ? [] : [source];
		} catch {
			return [];
		}
	}
	// The image's `[Image: source: …]` path is not checked: unlike a notice, it does
	// not tell the model to go read the file, so a missing copy changes nothing.
	if (!Array.isArray(content)) return [];
	const kept = (content as Rec[]).filter((b) => !(b?.type === "text" && typeof b.text === "string" && IMAGE_SOURCE.test(b.text)));
	if (kept.length === content.length) return [];
	const source = canonicalBlocks(kept);
	return source === undefined ? [] : [source];
}

/**
 * Replace converted tool_result content with CC's own where it was derived from the
 * same result. Mutates `messages` in place, before import. Returns the ids replaced.
 */
export function applyCarriedToolResults(
	messages: readonly { role: string; content: unknown }[],
	carried: ReadonlyMap<string, CarriedToolResult>,
): string[] {
	const replaced: string[] = [];
	if (!carried.size) return replaced;
	for (const msg of messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content as Rec[]) {
			if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const match = carried.get(block.tool_use_id);
			if (!match || match.isError !== (block.is_error === true)) continue;
			const current = canonicalBlocks(block.content);
			if (current === undefined || !match.sources.includes(current)) continue;
			block.content = match.content;
			replaced.push(block.tool_use_id);
		}
	}
	return replaced;
}
