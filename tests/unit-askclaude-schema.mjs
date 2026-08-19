import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	askClaudeCallTags,
	askClaudeToolDescription,
	buildAskClaudeParams,
	resolveAskClaudeDefaults,
} from "../src/askclaude-schema.js";

const props = (conf) => buildAskClaudeParams(resolveAskClaudeDefaults(conf)).properties;
const toolDescription = (conf) => askClaudeToolDescription(resolveAskClaudeDefaults(conf), conf?.description);
const tags = (args, conf) => askClaudeCallTags(args, resolveAskClaudeDefaults(conf));

describe("default configuration", () => {
	it("keeps the existing descriptions", () => {
		const parameters = props(undefined);
		assert.equal(parameters.prompt.description, "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore.");
		assert.equal(parameters.mode.description, '"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access). "full": allows writing and bash execution (careful: runs without feedback to pi).');
		assert.equal(parameters.isolated.description, "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history.");
		assert.equal(toolDescription(undefined), "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.");
	});

	it("offers every mode and tags nothing on a bare call", () => {
		assert.deepEqual(props({}).mode.enum, ["read", "full", "none"]);
		assert.deepEqual(tags({ prompt: "hi" }, {}), []);
	});

	it("tags explicit non-default options", () => {
		assert.deepEqual(tags({ prompt: "hi", mode: "full", model: "sonnet", thinking: "high", isolated: true }, {}),
			["mode=full", "model=sonnet", "thinking=high", "isolated"]);
	});
});

describe("defaultMode: full", () => {
	const conf = { defaultMode: "full" };

	it("states full as the default", () => {
		assert.match(props(conf).mode.description, /"full" \(default\)/);
		assert.doesNotMatch(props(conf).mode.description, /"read" \(default\)/);
		assert.match(toolDescription(conf), /Defaults to full mode/);
	});

	it("shows inherited write access in the status line", () => {
		assert.deepEqual(tags({ prompt: "review this" }, conf), ["mode=full"]);
		assert.deepEqual(tags({ prompt: "review this", mode: "read" }, conf), []);
	});
});

describe("defaultIsolated: true", () => {
	const conf = { defaultIsolated: true };

	it("states isolation as the default", () => {
		const parameters = props(conf);
		assert.equal(parameters.isolated.description, "When true (default), Claude sees only this prompt (clean session). When false, Claude sees the full conversation history.");
		assert.match(parameters.prompt.description, /By default Claude sees only this prompt \(isolated session\)\./);
	});

	it("shows inherited isolation in the status line", () => {
		assert.deepEqual(tags({ prompt: "review this" }, conf), ["isolated"]);
		assert.deepEqual(tags({ prompt: "review this", isolated: false }, conf), []);
	});
});

describe("allowFullMode: false", () => {
	it("removes full from the schema", () => {
		const parameters = props({ allowFullMode: false });
		assert.deepEqual(parameters.mode.enum, ["read", "none"]);
		assert.doesNotMatch(parameters.mode.description, /"full"/);
	});

	it("overrides a conflicting full default", () => {
		const conf = { allowFullMode: false, defaultMode: "full" };
		assert.equal(resolveAskClaudeDefaults(conf).mode, "read");
		assert.deepEqual(tags({ prompt: "hi" }, conf), []);
	});
});

describe("other configured defaults", () => {
	it("states and renders none as the default mode", () => {
		assert.match(props({ defaultMode: "none" }).mode.description, /"none" \(default\)/);
		assert.match(toolDescription({ defaultMode: "none" }), /Defaults to no file access/);
		assert.deepEqual(tags({ prompt: "what is a monad" }, { defaultMode: "none" }), ["mode=none"]);
	});

	it("preserves a description override verbatim", () => {
		assert.equal(toolDescription({ description: "Ask the other Claude.", defaultMode: "full", defaultIsolated: true }), "Ask the other Claude.");
	});
});
