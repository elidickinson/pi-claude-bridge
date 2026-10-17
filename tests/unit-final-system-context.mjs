// Synthetic reproductions of issue #153. No Claude login, saved session or MCP
// server is needed: Pi's own builder supplies the structured system messages.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectPromptCapture } from "../src/prompt-capture.js";
import { toBridgeContext } from "../src/transcript.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";
import { __test } from "../src/index.js";

const { buildSystemPrompt, buildSystemPromptSections } = await import(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url)
);

const system = (sections) => ({ role: "system", content: "", sections, timestamp: 0 });
const wrap = (name, value) => `<${name}>\n${value}\n</${name}>`;
function options(label) {
	return {
		customPrompt: `Synthetic agent: ${label}.`,
		cwd: "/example",
		appendSystemPrompt: "Keep the example instructions.",
		selectedTools: ["read"],
		contextFiles: [{ path: "/example/AGENTS.md", content: "Example project instructions." }],
		skills: [{ name: "example-skill", description: "Example skill.", filePath: "/example/skills/SKILL.md", baseDir: "/example/skills", disableModelInvocation: false }],
		sections: { example_notes: "Earlier example notes." },
	};
}
function prepare(label) {
	const handlers = activateWithMockPi();
	const input = options(label);
	handlers.get("before_agent_start")({ systemPrompt: buildSystemPrompt(input), systemPromptOptions: input });
	// A later handler adds native MCP instructions and changes the custom order.
	// Keep the options object itself: Pi shares it across before_agent_start.
	input.sections = { mcp_servers: "Use the example MCP tools.", example_notes: "Final example notes." };
	return { handlers, input };
}
async function finalize(handlers, input, messages) {
	const before = structuredClone(messages);
	// Deliberately do not fire agent_start/turn_start: this capture must finish on
	// the awaited request path without relying on notification-handler scheduling.
	const result = await handlers.get("context_with_system")?.({ messages }, { getSystemPrompt: () => buildSystemPrompt(input) });
	assert.equal(result, undefined, "the capture hook must not replace request messages");
	assert.deepEqual(messages, before, "saved section patches must not be rewritten");
	return toBridgeContext({ messages }).systemPrompt;
}

describe("final structured system-context capture (#153)", () => {
	it("captures a late MCP section before the first provider lookup", async () => {
		const { handlers, input } = prepare("late MCP");
		const messages = [system(buildSystemPromptSections(input))];
		const key = toBridgeContext({ messages }).systemPrompt;
		assert.throws(() => __test.promptCaptures.resolveOrDerive(key), /no capture/);
		await finalize(handlers, input, messages);
		const capture = __test.promptCaptures.resolveOrDerive(key);
		assert.equal(capture.source, "context_with_system");
		const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
		for (const text of [input.customPrompt, input.appendSystemPrompt, input.contextFiles[0].content, "example-skill", ...Object.values(input.sections)]) {
			assert.ok(projected.includes(text), `portable instruction missing: ${text}`);
		}
		input.contextFiles[0].content = "Later file contents.";
		input.sections.mcp_servers = "Later MCP instructions.";
		assert.equal(capture.contextFiles[0].content, "Example project instructions.");
		assert.equal(capture.sections.mcp_servers, "Use the example MCP tools.");
	});

	it("resolves custom sections in historical replay order as well as current builder order", async () => {
		const { handlers, input } = prepare("resumed order");
		const desired = buildSystemPromptSections(input);
		const { mcp_servers, example_notes, ...builtins } = desired;
		const messages = [system({ ...builtins, example_notes }), system({ mcp_servers })];
		const live = buildSystemPrompt(input);
		const replay = toBridgeContext({ messages }).systemPrompt;
		assert.equal(replay.length, live.length);
		assert.notEqual(replay, live, "Pi section patches do not express a move of unchanged content");
		handlers.get("agent_start")({}, { getSystemPrompt: () => live });
		assert.ok(__test.promptCaptures.resolve(live), "the builder key alone is insufficient even when agent_start completed");
		assert.throws(() => __test.promptCaptures.resolveOrDerive(replay), /no capture/);
		await finalize(handlers, input, messages);
		for (const key of [replay, live]) {
			assert.deepEqual(__test.promptCaptures.resolveOrDerive(key).sections, input.sections);
		}
		const child = __test.promptCaptures.resolveOrDerive(`${live}\n\nSynthetic child instructions.`);
		assert.ok(child.inherited.length > 0, "the finalized live key remains available for inheritance");
		assert.match(projectPromptCapture(child, { skillReadTool: "mcp" }), /Synthetic child instructions/);
	});

	it("handles deleted and reintroduced sections without changing their saved order", async () => {
		const { handlers, input } = prepare("reintroduced MCP");
		const full = buildSystemPromptSections(input);
		const messages = [system(full), system({ mcp_servers: null }), system({ mcp_servers: full.mcp_servers })];
		handlers.get("agent_start")({}, { getSystemPrompt: () => buildSystemPrompt(input) });
		assert.throws(() => __test.promptCaptures.resolveOrDerive(toBridgeContext({ messages }).systemPrompt), /no capture/);
		const key = await finalize(handlers, input, messages);
		assert.equal(__test.promptCaptures.resolveOrDerive(key).sections.mcp_servers, input.sections.mcp_servers);
	});

	for (const [label, change] of [
		["changed custom section", (sections) => { sections.mcp_servers = wrap("mcp_servers", "Different instructions."); }],
		["missing custom section", (sections) => { delete sections.mcp_servers; }],
		["unknown custom section", (sections) => { sections.unaccounted = wrap("unaccounted", "Unknown instructions."); }],
		["changed built-in section", (sections) => { sections.cwd = wrap("cwd", "/different"); }],
		["changed append", (sections) => { sections.addendum = wrap("addendum", "Different appended instructions."); }],
	]) {
		it(`rejects ${label}`, async () => {
			const { handlers, input } = prepare(label);
			const sections = buildSystemPromptSections(input);
			change(sections);
			const key = await finalize(handlers, input, [system(sections)]);
			assert.equal(__test.promptCaptures.resolve(key), undefined);
			assert.throws(() => __test.promptCaptures.resolveOrDerive(key), /prompt-capture:/);
		});
	}

	it("does not manufacture a capture when before_agent_start did not supply options", async () => {
		const handlers = activateWithMockPi();
		const input = options("missing options");
		const key = await finalize(handlers, input, [system(buildSystemPromptSections(input))]);
		assert.throws(() => __test.promptCaptures.resolveOrDerive(key), /no capture/);
	});

	it("leaves forced and opaque prompts on the existing resolution path", async () => {
		const { handlers, input } = prepare("forced prompt");
		input.forceSystemPrompt = "Synthetic opaque override.";
		await finalize(handlers, input, [system(buildSystemPromptSections(input))]);
		assert.equal(__test.promptCaptures.resolve(input.forceSystemPrompt), undefined);
		delete input.forceSystemPrompt;
		const message = { ...system(buildSystemPromptSections(input)), content: "Opaque context replacement." };
		const key = await finalize(handlers, input, [message]);
		assert.equal(__test.promptCaptures.resolve(key), undefined);
	});
});
