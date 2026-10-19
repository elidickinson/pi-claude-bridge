// Test client for the bridge's in-process MCP servers.

// Mirrors the SDK's connectSdkMcpServer: hand the instance a transport, push
// requests into transport.onmessage, read replies out of transport.send.
export async function connectClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => pending.get(msg.id)?.(msg),
	};
	await server.instance.connect(transport);

	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});

	// Claude Code identifies the call it is making via _meta on every tools/call.
	const callTool = (name, toolUseId, args = {}) =>
		request("tools/call", {
			name,
			arguments: args,
			...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { request, callTool };
}
