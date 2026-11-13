// Golden contract: the bridge forwards pi's system prompt whole, byte for byte as pi
// renders it. Replaces the prompt-capture tests -- there is no capture table or projection
// anymore. toBridgeContext joins pi's sections via pi-ai (getSystemMessageText) and the
// provider sends that string as the preset's append (or a plain string when off). Each case pins the
// forwarded text against pi's real buildSystemPrompt across the prompt shapes pi produces.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { __test } from "../src/index.js";

const { toBridgeContext } = __test;
const { buildSystemPrompt, buildSystemPromptState, buildSystemPromptSections } =
	await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);

const cwd = "/tmp/project";
const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };

/** A transcript head exactly as pi writes it: buildSystemPromptState's content + sections. */
function head(opts) {
	const state = buildSystemPromptState(opts);
	return { role: "system", content: state.content, sections: state.sections, timestamp: 0 };
}

/** The bridge must forward pi's rendered prompt verbatim, keeping system messages out of history. */
function assertForwardsPiPrompt(opts, messages) {
	const result = toBridgeContext({ messages: [...messages, user] });
	assert.equal(result.systemPrompt, buildSystemPrompt(opts));
	assert.ok(!result.messages.some((message) => message.role === "system"), "system messages stay out of history");
}

describe("system prompt golden: toBridgeContext forwards pi's prompt whole", () => {
	it("default", () => assertForwardsPiPrompt({ cwd }, [head({ cwd })]));

	it("--system-prompt replaces the preamble", () => {
		const opts = { cwd, customPrompt: "You are a terse release-notes bot." };
		assertForwardsPiPrompt(opts, [head(opts)]);
	});

	it("--append-system-prompt adds an addendum", () => {
		const opts = { cwd, appendSystemPrompt: "Always cite the changelog." };
		assertForwardsPiPrompt(opts, [head(opts)]);
	});

	it("forced prompt arrives as content only", () => {
		const opts = { cwd, forceSystemPrompt: "FORCE: reply in haiku." };
		assertForwardsPiPrompt(opts, [head(opts)]);
	});

	it("a context_with_system handler that replaces the prompt", () => {
		// A handler replaces messages[0] with its own content; a later resume patch still
		// applies. The bridge forwards pi-ai's collapse of the two, not the builder's prompt.
		const replaced = { role: "system", content: "Replaced by a context_with_system handler.", timestamp: 0 };
		const patch = { role: "system", content: "", sections: { cwd: buildSystemPromptSections({ cwd }).cwd }, timestamp: 1 };
		const messages = [replaced, patch, user];
		const result = toBridgeContext({ messages });
		assert.equal(result.systemPrompt, getSystemMessageText(getCurrentSystemMessage(messages)));
		assert.ok(result.systemPrompt.startsWith("Replaced by a context_with_system handler."), "the handler's replacement leads");
		assert.ok(result.systemPrompt.includes(buildSystemPromptSections({ cwd }).cwd), "the later section patch survives");
	});

	it("a child embedding its parent's prompt keeps the wrapper", () => {
		const parent = buildSystemPrompt({ cwd });
		const opts = { cwd, customPrompt: `${parent}\n\n<sub_agent_context>be concise</sub_agent_context>` };
		assertForwardsPiPrompt(opts, [head(opts)]);
	});

	it("resume replays a section patch", () => {
		const after = { cwd: "/tmp/other" };
		const patch = { role: "system", content: "", sections: { cwd: buildSystemPromptSections(after).cwd }, timestamp: 1 };
		assertForwardsPiPrompt(after, [head({ cwd }), patch]);
	});

	it("forwards pi-ai's replay order when a section is deleted and re-added", () => {
		// The bridge forwards pi-ai's join (getSystemMessageText), not the builder's canonical
		// order: a deleted-then-re-added section lands at the replay tail. This is intentional --
		// the prompt is pi's own join of its own sections, with no re-ranking in the bridge.
		const opts = { cwd, appendSystemPrompt: "ADDENDUM" };
		const state = buildSystemPromptState(opts);
		const messages = [
			{ role: "system", content: state.content, sections: { ...state.sections }, timestamp: 0 },
			{ role: "system", content: "", sections: { addendum: null }, timestamp: 1 },
			{ role: "system", content: "", sections: { addendum: state.sections.addendum }, timestamp: 2 },
			user,
		];
		const result = toBridgeContext({ messages });
		assert.equal(result.systemPrompt, getSystemMessageText(getCurrentSystemMessage(messages)));
		assert.ok(result.systemPrompt.endsWith(state.sections.addendum), "the re-added section lands at the replay tail, after cwd");
	});
});