// Test extension: a few tools nothing in a coding prompt calls for, one of them
// the only way to answer the test's question. None is on the bridge's always-load
// list, so with provider.toolSearch Claude has to find it through ToolSearch.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const lookup = Type.Object({ vessel: Type.String({ description: "Name of the vessel" }) });
	pi.registerTool<typeof lookup>({
		name: "harbor_berth_lookup",
		label: "Harbor berth lookup",
		description: "Look up the berth code the harbor registry assigned to a vessel. Returns the code as plain text.",
		parameters: lookup,
		async execute(_id, params) {
			return { content: [{ type: "text" as const, text: `BERTH-7Q4 is the berth of ${params.vessel}` }], details: {} };
		},
	});

	const port = Type.Object({ port: Type.String({ description: "Name of the port" }) });
	for (const [name, description] of [
		["tide_table", "List today's high and low tides at a port."],
		["customs_manifest", "Fetch the customs manifests filed at a port today."],
		["crane_schedule", "List the crane bookings at a port for the current shift."],
	]) {
		pi.registerTool<typeof port>({
			name,
			label: name,
			description,
			parameters: port,
			async execute() {
				return { content: [{ type: "text" as const, text: `${name}: nothing scheduled` }], details: {} };
			},
		});
	}
}
