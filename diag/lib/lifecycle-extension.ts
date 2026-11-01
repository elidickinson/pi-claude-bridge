// Test extension for diag/lifecycle-runner.mjs: fixed local tools and the
// in-process state changes the runner's scenarios need. The runner steers it
// through a JSON control file (LIFECYCLE_CONTROL), read on every use:
//   { "forceRebuild": true }  next agent start marks the bridge for rebuild,
//                             leaving pi's history unchanged (a no-op rebuild)
//   { "redact": true }        provider calls see SECRET-dddd replaced by a
//                             same-length mask, with no rebuild mark
// lc_wait blocks until the runner creates `gate` next to the control file.
// lc_fail, lc_image and lc_dump return the content kinds a rebuild has to carry:
// an error, an image, and output over Claude Code's tool-result persistence
// threshold (50,000 characters).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const controlFile = () => process.env.LIFECYCLE_CONTROL ?? "";
const control = (): { forceRebuild?: boolean; redact?: boolean } =>
	existsSync(controlFile()) ? JSON.parse(readFileSync(controlFile(), "utf8")) : {};

// 16x16 solid red PNG.
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IyJCEmIY1TCqYfhqAAACcQQQFd0BdQAAAABJRU5ErkJggg==";
const DUMP = ["DUMP-START codeword ochre19", ...Array.from({ length: 820 }, (_, i) => `report line ${String(i + 1).padStart(4, "0")}: ${"lorem ipsum dolor sit amet ".repeat(2)}`)].join("\n");

export default function (pi: ExtensionAPI) {
	const key = Type.Object({ key: Type.String({ description: "Record key" }) });
	pi.registerTool<typeof key>({
		name: "lc_lookup",
		label: "Look up a record",
		description: "Looks up a fixed record by key and returns its value. Use when asked to look up a key.",
		parameters: key,
		async execute(_id, params) {
			return { content: [{ type: "text" as const, text: `record ${params.key}: value-${params.key.length}` }], details: undefined };
		},
	});

	const none = Type.Object({});
	pi.registerTool<typeof none>({
		name: "lc_fail",
		label: "Fail on purpose",
		description: "Always fails with an error. Use when asked to call lc_fail.",
		parameters: none,
		async execute() {
			throw new Error("lc_fail: deliberate failure FAIL-7731");
		},
	});
	pi.registerTool<typeof none>({
		name: "lc_image",
		label: "Return an image",
		description: "Returns a small image. Use when asked to call lc_image.",
		parameters: none,
		async execute() {
			return { content: [{ type: "image" as const, data: RED_PNG, mimeType: "image/png" }], details: undefined };
		},
	});
	pi.registerTool<typeof none>({
		name: "lc_dump",
		label: "Dump a long report",
		description: "Returns a long fixed report. Use when asked to call lc_dump.",
		parameters: none,
		async execute() {
			return { content: [{ type: "text" as const, text: DUMP }], details: undefined };
		},
	});

	const label = Type.Object({ label: Type.String({ description: "Label for this wait" }) });
	pi.registerTool<typeof label>({
		name: "lc_wait",
		label: "Wait for a signal",
		description: "Waits until an external signal arrives, then returns. Use when asked to wait.",
		parameters: label,
		async execute(_id, params, signal) {
			const gate = join(dirname(controlFile()), "gate");
			const deadline = Date.now() + 120_000;
			while (!existsSync(gate)) {
				if (signal?.aborted) throw new Error("aborted");
				if (Date.now() > deadline) throw new Error("lc_wait: gate never opened");
				await new Promise((r) => setTimeout(r, 100));
			}
			return { content: [{ type: "text" as const, text: `waited ${params.label}` }], details: undefined };
		},
	});

	const note = Type.Object({ note: Type.String({ description: "Checkpoint note" }) });
	pi.registerTool<typeof note>({
		name: "lc_stop",
		label: "Record a checkpoint",
		description: "Records a checkpoint note and ends the turn. Use when asked to record a checkpoint.",
		parameters: note,
		async execute(_id, params) {
			// Ends the run with Claude Code's query still parked at this tool call.
			return { content: [{ type: "text" as const, text: `checkpoint ${params.note}` }], details: undefined, terminate: true };
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!control().forceRebuild) return;
		const hooks = (globalThis as any)[Symbol.for("claude-bridge:markRebuildHooks")];
		if (!hooks?.size) throw new Error("lifecycle: claude-bridge markRebuildHooks registry not found");
		for (const hook of hooks) hook(ctx.sessionManager.getSessionId(), "lifecycle-force-rebuild");
	});

	pi.on("context", (event) => {
		if (!control().redact) return undefined;
		const scrub = (s: string) => s.replace(/SECRET-[0-9]{4}/g, "XXXXXX-XXXX");
		return {
			messages: event.messages.map((m: any) => {
				// Signed thinking cannot be edited; omit a block that contains the secret.
				const content = typeof m.content === "string" ? m.content : m.content.filter((b: any) => b.type !== "thinking" || scrub(b.thinking ?? "") === (b.thinking ?? ""));
				return JSON.parse(JSON.stringify({ ...m, content }, (_key, value) => typeof value === "string" ? scrub(value) : value));
			}),
		};
	});

	pi.registerCommand("lc-tree-back", {
		description: "Move the session leaf back to the end of the first turn",
		handler: async (_args, ctx) => {
			const users = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message?.role === "user");
			const second = users[1] as any;
			if (!second?.parentId) throw new Error("lc-tree-back: needs at least two turns");
			const result = await ctx.navigateTree(second.parentId);
			if (result.cancelled) throw new Error("lc-tree-back: navigation cancelled");
		},
	});
}
