import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let loads = 0;
	let calls = 0;
	const marker = randomUUID();
	pi.registerTool({
		name: "enable_probe",
		label: "Enable probe",
		description: "Enable the hidden dynamic_probe tool. Call it next in this same task.",
		parameters: Type.Object({}),
		async execute() {
			loads++;
			pi.setActiveTools([...pi.getActiveTools().filter((name) => name !== "enable_probe"), "dynamic_probe"]);
			return { content: [{ type: "text", text: "dynamic_probe is now available. Call it once, then return its result." }], details: {} };
		},
	});
	pi.registerTool({
		name: "dynamic_probe",
		label: "Dynamic probe",
		description: "Return the verification marker and execution counts.",
		parameters: Type.Object({}),
		async execute() {
			calls++;
			return { content: [{ type: "text", text: `dynamic-tools-ok:${marker}` }], details: { loads, calls, marker } };
		},
	});
	pi.on("session_start", () => pi.setActiveTools(["enable_probe"]));
}
