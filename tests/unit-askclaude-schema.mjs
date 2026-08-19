import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	askClaudeCallTags,
	askClaudeToolDescription,
	buildAskClaudeParams,
	resolveAskClaudeDefaults,
	resolveAskClaudeMode,
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

	it("shows inherited write access and a read-only override in the status line", () => {
		assert.deepEqual(tags({ prompt: "review this" }, conf), ["mode=full"]);
		assert.deepEqual(tags({ prompt: "review this", mode: "read" }, conf), ["mode=read"]);
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

	it("rejects full mode during execution even if a caller bypasses the schema", () => {
		const defaults = resolveAskClaudeDefaults({ allowFullMode: false });
		assert.throws(() => resolveAskClaudeMode("full", defaults), /full mode is disabled/);
		assert.throws(() => resolveAskClaudeMode("unexpected", defaults), /Invalid AskClaude mode/);
		assert.throws(() => resolveAskClaudeMode(null, defaults), /Invalid AskClaude mode/);
		assert.equal(resolveAskClaudeMode(undefined, defaults), "read");
	});

	it("fails closed for a malformed non-boolean allowFullMode", () => {
		assert.equal(resolveAskClaudeDefaults({ allowFullMode: "false" }).allowFull, false);
		assert.equal(resolveAskClaudeDefaults({ allowFullMode: 0 }).allowFull, false);
	});

	it("keeps the package default true for a null or omitted allowFullMode", () => {
		assert.equal(resolveAskClaudeDefaults({ allowFullMode: null }).allowFull, true);
		assert.equal(resolveAskClaudeDefaults({}).allowFull, true);
		assert.equal(resolveAskClaudeDefaults(undefined).allowFull, true);
	});
});

describe("other configured defaults", () => {
	it("states and renders none as the default mode, including an explicit read escalation", () => {
		const conf = { defaultMode: "none" };
		assert.match(props(conf).mode.description, /"none" \(default\)/);
		assert.match(toolDescription(conf), /Defaults to no file access/);
		assert.deepEqual(tags({ prompt: "what is a monad" }, conf), ["mode=none"]);
		assert.deepEqual(tags({ prompt: "review this", mode: "read" }, conf), ["mode=read"]);
	});

	it("falls back to generated text for a null description", () => {
		assert.equal(toolDescription({ description: null }), toolDescription({}));
	});

	it("returns a non-null configured description verbatim", () => {
		const conf = { defaultMode: "none", description: "Custom override text" };
		assert.equal(toolDescription(conf), "Custom override text");
	});

	it("treats a null configured mode as unset, falling back to the package default", () => {
		assert.equal(resolveAskClaudeDefaults({ defaultMode: null }).mode, "read");
	});

	it("fails closed for an invalid configured mode", () => {
		assert.equal(resolveAskClaudeDefaults({ defaultMode: "unexpected" }).mode, "none");
	});
});
