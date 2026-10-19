// Refuses prompt text that makes Claude Code's subscription path read a request as a
// third-party app. Shared by the captured agent path and standalone prompts.

import { debugLogPath } from "./log-paths.js";

/** Pi's own preamble, the first section of every prompt pi renders for a session
 *  without a custom prompt. Machine-generated, so operator text never carries it;
 *  forwarding it makes Claude Code's subscription path read the request as a
 *  third-party app. */
export const PI_PREAMBLE = "You are an expert coding assistant operating inside pi";

/** Both doc paths from pi's documentation-routing line. Anthropic's subscription gate
 *  rejects a system prompt carrying both, while either alone passes (issues #883, #88). */
const ANTHROPIC_THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"];

/** One piece of a prompt, named so a refusal can say where it found the text. */
export type PromptPart = { label: string; text: string };

/** Throws when any part carries pi's preamble at a line start, or the phrase pair
 *  Anthropic's subscription gate rejects. `notes` add caller context to the refusal. */
export function assertSendable(parts: readonly PromptPart[], scope: string, notes: readonly string[]): void {
	const findings: string[] = [];
	for (const { label, text } of parts) {
		const offset = preambleAtLineStart(text);
		if (offset !== -1) {
			findings.push(`pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`);
		}
		// The pair has to co-occur in one part; the two phrases split across parts are not detected.
		if (ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
			findings.push(`${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}`);
		}
	}
	if (findings.length === 0) return;

	throw new Error([
		`${scope}: refusing to send this prompt. Claude Code's Anthropic path reads a request`,
		"  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
		"  app: it fails with 400 or is billed as extra usage.",
		...findings.map((finding) => `  Found: ${finding}.`),
		...notes,
		"  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
		`  ${debugLogPath()}.`,
	].join("\n"));
}

/** Offset of pi's preamble at the start of a line, or -1. Mid-line mentions are someone
 *  describing pi's prompt, not pi's prompt. */
function preambleAtLineStart(text: string): number {
	for (let offset = text.indexOf(PI_PREAMBLE); offset !== -1; offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)) {
		if (offset === 0 || text[offset - 1] === "\n") return offset;
	}
	return -1;
}
