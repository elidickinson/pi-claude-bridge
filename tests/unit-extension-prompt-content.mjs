import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptCaptures, projectPromptCapture, PI_PREAMBLE } from "../src/prompt-capture.js";
import activate, { __test } from "../src/index.js";

const project = (capture) => projectPromptCapture(capture, { skillReadTool: "none" });
const input = (extra = {}) => ({ contextFiles: [], skills: [], ...extra });

describe("extension prompt content", () => {
	it("snapshots guidelines and snippets, trims/deduplicates rules, and clears stale fields", () => {
		const captures = new PromptCaptures();
		const options = input({ promptGuidelines: [" global rule ", "shared", " "],
			toolGuidelines: { lookup: ["tool rule", "shared"] }, toolSnippets: { lookup: "Find records" } });
		captures.record("key", options);
		options.promptGuidelines.push("late global");
		options.toolGuidelines.lookup.push("late tool");
		options.toolSnippets.lookup = "late snippet";
		const result = project(captures.resolve("key"));
		assert.match(result, /- lookup: Find records/);
		assert.match(result, /- tool rule\n- shared\n- global rule/);
		assert.doesNotMatch(result, /late/);
		assert.equal(result.split("- shared").length - 1, 1);
		captures.record("key", input());
		assert.equal(project(captures.resolve("key")), undefined);
	});

	it("keeps extension content through inheritance and guards against harness leakage", () => {
		const captures = new PromptCaptures();
		captures.record("parent assembled", input({ promptGuidelines: ["parent rule"], toolSnippets: { lookup: "Find records" } }));
		captures.record("child assembled", input({ custom: "parent assembled\nchild rule" }));
		assert.match(project(captures.resolve("child assembled")), /parent rule/);
		assert.match(project(captures.resolve("child assembled")), /lookup: Find records/);
		const harness = `Untrusted instructions\n${PI_PREAMBLE}`;
		for (const extra of [{ promptGuidelines: [harness] }, { toolSnippets: { lookup: harness } }, { toolGuidelines: { lookup: [harness] } }]) {
			captures.record("unsafe", input(extra));
			assert.throws(() => project(captures.resolve("unsafe")), /refusing to send/);
		}
	});

	it("captures selected extension tools at every boundary without restoring pi-owned tool guidance", () => {
		const handlers = new Map();
		let tools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "sdk_tool", sourceInfo: { source: "sdk" } },
			{ name: "lookup", sourceInfo: { source: "extension" } },
		];
		activate({ on: (event, handler) => handlers.set(event, handler), registerProvider() {}, registerTool() {}, getAllTools: () => tools });
		const options = { selectedTools: ["read", "sdk_tool", "lookup"], customPrompt: "custom instructions",
			promptGuidelines: ["global rule"],
			toolSnippets: { read: "pi read", sdk_tool: "pi SDK", lookup: "Find records", inactive: "hidden" },
			toolGuidelines: { read: ["pi read rule"], sdk_tool: ["pi SDK rule"], lookup: ["lookup rule"], inactive: ["hidden rule"] },
			sections: { mcp_servers: "MCP instructions" } };
		handlers.get("before_agent_start")({ systemPrompt: "extension initial", systemPromptOptions: options });
		for (const [event, key] of [["agent_start", "extension final"], ["turn_start", "extension turn"]]) {
			handlers.get(event)({}, { getSystemPrompt: () => key });
			const result = project(__test.promptCaptures.resolve(key));
			assert.match(result, /lookup: Find records/);
			assert.match(result, /lookup rule/);
			assert.match(result, /global rule/);
			assert.match(result, /custom instructions/);
			assert.match(result, /<mcp_servers>\nMCP instructions\n<\/mcp_servers>/);
			assert.doesNotMatch(result, /pi read|pi SDK|hidden/);
		}
		// Inventory is session-owned and may change between capture boundaries.
		tools = [...tools, { name: "lookup", sourceInfo: { source: "sdk" } }];
		handlers.get("turn_start")({}, { getSystemPrompt: () => "extension changed inventory" });
		assert.doesNotMatch(project(__test.promptCaptures.resolve("extension changed inventory")), /lookup/);
		options.selectedTools = [];
		handlers.get("turn_start")({}, { getSystemPrompt: () => "extension no tools" });
		assert.match(project(__test.promptCaptures.resolve("extension no tools")), /global rule/);
	});
});
