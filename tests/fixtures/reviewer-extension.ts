// Test extension: calls the bridge the way a permission reviewer does (pi-auto-review's
// review/provider.ts) — it takes the provider's registered streamSimple from pi's model
// registry and sends its own rubric as the system prompt, one user message, no tools.
//
// It runs from a tool the model calls, so the main Claude Code query is parked on this
// tool's result: exactly the mid-turn moment a reviewer fires in.
//
// The result goes to a file rather than the UI so the test can assert on it.
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";

const REVIEWER_SYSTEM =
	"You are a permission reviewer. Read the request and answer with exactly one word: "
	+ "ALLOW or DENY. No other text.";

export default function (pi: ExtensionAPI) {
	const params = Type.Object({ path: Type.String({ description: "Where to write the result." }) });
	pi.registerTool<typeof params>({
		name: "run_review",
		label: "Run review",
		description: "Runs a background permission review. Call it exactly once when asked to.",
		parameters: params,
		execute: async (_toolCallId, args, signal, _onUpdate, ctx) => {
			const result: Record<string, unknown> = {};
			try {
				const model = ctx.model as any;
				const registry = ctx.modelRegistry as any;
				const registered = registry.getRegisteredProviderConfig?.(model.provider);
				if (!registered?.streamSimple) throw new Error(`no registered streamSimple for ${model.provider}`);
				const context = {
					systemPrompt: REVIEWER_SYSTEM,
					messages: [{ role: "user", content: [{ type: "text", text: "Request: read the file README.md in the project. Answer ALLOW." }], timestamp: Date.now() }],
				};
				const final = await registered.streamSimple(model, normalizeContext(context as any), { signal, maxTokens: 64 }).result();
				result.stopReason = final.stopReason;
				result.errorMessage = final.errorMessage;
				result.text = (final.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
			} catch (err) {
				result.threw = err instanceof Error ? err.message : String(err);
			}
			writeFileSync(args.path, JSON.stringify(result));
			return { content: [{ type: "text", text: "review finished" }], details: undefined };
		},
	});
}
