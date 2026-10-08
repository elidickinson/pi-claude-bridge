// Shared stub pi for calling the extension's default export in unit tests.
// Returns the Map of event handlers the stub recorded. Pass activateFn to
// override the activate function (e.g. a freshly re-imported module instance).
//
// registerTool is stubbed too: activate() calls pi.registerTool when the loaded
// config enables AskClaude (e.g. a developer's global ~/.pi/agent/claude-bridge.json),
// so a mock missing it throws before any handler is registered. CI has no such
// config, which is why this only surfaced locally.
const { default: activate } = await import("../../src/index.js");

export function activateWithMockPi(activateFn) {
	const handlers = new Map();
	(activateFn ?? activate)({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return handlers;
}
