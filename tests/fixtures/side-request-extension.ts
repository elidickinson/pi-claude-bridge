// Test extension: drives a model the way a note-taking extension does — its own
// `agentLoop`, its own system prompt, its own tool, and no `streamFn`. That last part is what makes this shape distinct: pi-ai's default
// stream function resolves the api id in pi-ai's registry, so the call reaches the
// bridge only through its api-provider registration, and no pi-side takeover can
// intercept it.
//
// The result goes to a file rather than the UI so the test can assert on it.
import { agentLoop, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";

const NOTE_TAKER_SYSTEM =
	"You record notes about a conversation. Call record_note for each note, "
	+ "then reply with a short plain-text confirmation to end the run.";

export default function (pi: ExtensionAPI) {
	async function runSideRequest(model: unknown, outPath: string, word: string) {
		const recorded: string[] = [];
		const recordNote: AgentTool<any> = {
			name: "record_note",
			label: "Record note",
			description: "Record one note about the conversation.",
			parameters: Type.Object({ content: Type.String({ description: "The note, one line." }) }),
			execute: async (_id: string, params: { content: string }) => {
				recorded.push(params.content);
				return { content: [{ type: "text", text: "Recorded. Stop calling the tool and confirm." }], details: undefined };
			},
		};

		const result: Record<string, unknown> = { recorded };
		try {
			const stream = agentLoop(
				[{
					role: "user",
					content: [{ type: "text", text: `Record a note whose content is exactly the word ${word}.` }],
					timestamp: Date.now(),
				}],
				{ systemPrompt: NOTE_TAKER_SYSTEM, messages: [], tools: [recordNote] },
				{ model, convertToLlm: (messages) => messages as any, toolExecution: "sequential" } as any,
				// No streamFn, which is the whole point: pi-ai's default is what routes by
				// api id, and it is the only route an extension like this one has.
				undefined,
				undefined as any,
			);
			for await (const _event of stream) {
				// Drain; the tool's execute collects what we assert on.
			}
			const final = await stream.result();
			result.stopReason = (final as any).at(-1)?.stopReason;
			result.errorMessage = (final as any).at(-1)?.errorMessage;
		} catch (err) {
			// A throw is itself a finding: this caller is the one whose rejections go
			// unhandled, so the bridge must report failures on the stream instead.
			result.threw = err instanceof Error ? err.message : String(err);
		}
		writeFileSync(outPath, JSON.stringify(result));
	}

	pi.registerCommand("side-request", {
		description: "Run a self-contained agent loop beside the conversation",
		handler: async (args, ctx) => {
			await runSideRequest(ctx.model, args.trim(), "GAMMA");
		},
	});

	// The overlap consolidation really runs in: a side request starting while a turn
	// of the conversation is still in flight. Running it from a tool the model calls
	// guarantees that — the main Claude Code query is parked on this tool result.
	const params = Type.Object({ path: Type.String({ description: "Where to write the result." }) });
	pi.registerTool<typeof params>({
		name: "run_side_request",
		label: "Run side request",
		description: "Runs a background note-taker over the conversation. Call it exactly once when asked to.",
		parameters: params,
		execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
			await runSideRequest(ctx.model, args.path, "DELTA");
			return { content: [{ type: "text", text: "side request finished" }], details: undefined };
		},
	});
}
