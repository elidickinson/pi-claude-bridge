import type { Context } from "@earendil-works/pi-ai";

/**
 * A foreign one-shot: a caller that obtained our streamSimple handle from pi's
 * model runtime (a permission reviewer, a judge) and sends its own rubric as the
 * system prompt with a single user message and no tools. It is not a turn of
 * pi's conversation, so it must not ride the main lane: mid-turn it would be
 * treated as a reentrant query of the active session, and its prompt never
 * resolves against pi's captured assembly.
 *
 * Every condition is required. A conversation turn always carries tools, so it
 * cannot land on the tool-less isolated path even if its prompt fails to
 * resolve; `resolve` is the same discriminator the main lane lives by (it
 * throws when the prompt was never captured and cannot be derived).
 */
export function isForeignOneShot(context: Context, resolve: (systemPrompt: string) => unknown): boolean {
	if (!context.systemPrompt) return false;
	if (context.messages.length !== 1 || context.messages[0]?.role !== "user") return false;
	if (context.tools && context.tools.length > 0) return false;
	try {
		resolve(context.systemPrompt);
		return false;
	} catch {
		return true;
	}
}
