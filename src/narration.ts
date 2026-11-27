/**
 * Claude Code's "narration" blocks.
 *
 * The prose a Claude 5 model writes between tool calls ("Now I'll check X…") often does not
 * arrive as `text`. The API summarizes it server-side and returns the summary as a
 * `thinking` block whose signature is tagged block_kind "narration" — "server summaries of
 * the prose between tool calls, not the model's own reasoning", in the words of Claude
 * Code's own SDK schema. Claude Code shows those as assistant prose marked as a summary; a
 * bridge that maps block types one to one shows them as reasoning, folded into the italic
 * thinking text.
 *
 * The API marks them only in the signature: `content_block_start` carries nothing, and the
 * signature arrives in a `signature_delta` right before `content_block_stop`. (Claude Code's
 * own `narration_block_indexes` is `@internal`, absent from sdk.d.ts, and a stored message
 * keeps only the signature.) The tag sits in the signature's protobuf envelope — top-level
 * field 2 → field 1 → field 8 (string) — the path Claude Code decodes. Fail-closed like
 * Claude Code: an unparseable or legacy signature has no kind, and its block stays ordinary
 * thinking.
 *
 * pi gets the block as a `text` block, a change of how it is shown and nothing more: the
 * text stays as received and the signature rides along in `textSignature`, so
 * convertPiMessages can hand the API back the signed thinking block it sent. The API wants
 * a turn's thinking blocks returned verbatim, and reads the full note from the signature.
 * Stored sessions therefore depend on the path above: if the tag ever moves, read the new
 * one as well, or every progress update already stored goes back to the API as plain text.
 */

/** The block_kind the server stamps on summaries of between-tool-call prose. */
export const NARRATION_KIND = "narration";

/**
 * How much of a thinking block is held back before it is shown, because whether it is
 * reasoning or narration is only known from the signature at the end of the block.
 * Narration summaries are short (none over ~530 chars in the samples recorded); real
 * reasoning summaries run on, and once one has passed this size it is streamed live as
 * before. A narration that outgrows it stays thinking, as it always was.
 */
export const NARRATION_HOLD_CHARS = 800;

/** Up to ten bytes, as protobuf allows and Claude Code reads (a negative int32 takes all ten).
 *  Past 2^53 the value is inexact, which only a skipped field or an out-of-bounds length reaches. */
function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | undefined {
	let value = 0;
	for (let shift = 0; shift < 70 && pos < buf.length; shift += 7) {
		const byte = buf[pos++];
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return { value, next: pos };
	}
	return undefined;
}

/** The first length-delimited field numbered `field` in a protobuf message. */
function lengthDelimitedField(buf: Uint8Array, field: number): Uint8Array | undefined {
	let pos = 0;
	while (pos < buf.length) {
		const key = readVarint(buf, pos);
		if (!key) return undefined;
		pos = key.next;
		const wireType = key.value % 8;
		const fieldNumber = Math.floor(key.value / 8);
		if (wireType === 0) {
			const skipped = readVarint(buf, pos);
			if (!skipped) return undefined;
			pos = skipped.next;
		} else if (wireType === 1) {
			pos += 8;
		} else if (wireType === 5) {
			pos += 4;
		} else if (wireType === 2) {
			const length = readVarint(buf, pos);
			if (!length) return undefined;
			pos = length.next;
			if (pos + length.value > buf.length) return undefined;
			if (fieldNumber === field) return buf.subarray(pos, pos + length.value);
			pos += length.value;
		} else {
			return undefined;
		}
	}
	return undefined;
}

/** The block_kind a thinking block's signature carries ("thinking", "narration"), if it parses. */
export function signatureBlockKind(signature: string | undefined): string | undefined {
	if (!signature) return undefined;
	try {
		const envelope = lengthDelimitedField(Buffer.from(signature, "base64"), 2);
		const header = envelope && lengthDelimitedField(envelope, 1);
		const kind = header && lengthDelimitedField(header, 8);
		return kind ? new TextDecoder("utf-8", { fatal: true }).decode(kind) : undefined;
	} catch {
		return undefined;
	}
}

/** A thinking block that is really prose written between tool calls, with text to show. */
export function isNarrationBlock(block: { thinking?: string; signature?: string }): boolean {
	return !!block.thinking?.trim() && signatureBlockKind(block.signature) === NARRATION_KIND;
}
