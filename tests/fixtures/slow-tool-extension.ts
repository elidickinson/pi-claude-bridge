// Test extension: registers a tool that blocks for a configurable duration,
// giving the test harness time to inject messages via RPC while the tool
// handler is waiting for a result.
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "SlowTool",
		label: "A tool that takes a while to return",
		description: "Waits for the specified number of seconds before returning. Use this when asked to call SlowTool.",
		parameters: Type.Object({
			seconds: Type.Optional(Type.Number({ description: "How long to wait before returning (default 5)" })),
		}),
		async execute(_id, params, signal) {
			const delay = (params.seconds ?? 5) * 1000;
			await new Promise((r, reject) => {
				const timer = setTimeout(r, delay);
				signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
			});
			return { content: [{ type: "text" as const, text: `SlowTool completed after ${delay}ms` }], details: {} };
		},
	});
}
