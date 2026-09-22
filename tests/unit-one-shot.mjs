/**
 * Tests for isForeignOneShot — the provider-entry discriminator that sends a
 * reviewer/judge call (own rubric, one user message, no tools) to the isolated
 * one-shot path instead of the main lane.
 * Pins: every condition is required; a conversation turn (tools present, or a
 * resolvable pi prompt) never qualifies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isForeignOneShot } from "../src/one-shot.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 });
const tool = { name: "bash", description: "run", parameters: { type: "object", properties: {} } };
const unresolvable = () => { throw new Error("prompt-capture: no match"); };
const resolvable = () => ({ key: "captured" });

const reviewerCall = (over = {}) => ({ systemPrompt: "You are a permission reviewer. Answer allow or deny.", messages: [user("{\"evidence\":{}}")], ...over });

describe("isForeignOneShot", () => {
	it("routes a reviewer-shaped call: own rubric, one user message, no tools", () => {
		assert.equal(isForeignOneShot(reviewerCall(), unresolvable), true);
		assert.equal(isForeignOneShot(reviewerCall({ tools: [] }), unresolvable), true);
	});

	it("keeps a conversation turn whose prompt resolves against pi's captures", () => {
		assert.equal(isForeignOneShot(reviewerCall(), resolvable), false);
	});

	it("never routes a call that carries tools, even with an unresolvable prompt", () => {
		assert.equal(isForeignOneShot(reviewerCall({ tools: [tool] }), unresolvable), false);
	});

	it("requires exactly one user message", () => {
		assert.equal(isForeignOneShot(reviewerCall({ messages: [user("a"), assistant(), user("b")] }), unresolvable), false);
		assert.equal(isForeignOneShot(reviewerCall({ messages: [assistant()] }), unresolvable), false);
		assert.equal(isForeignOneShot(reviewerCall({ messages: [] }), unresolvable), false);
	});

	it("requires a system prompt", () => {
		assert.equal(isForeignOneShot(reviewerCall({ systemPrompt: undefined }), unresolvable), false);
		assert.equal(isForeignOneShot(reviewerCall({ systemPrompt: "" }), unresolvable), false);
	});

	it("does not consult the resolver when a structural condition already fails", () => {
		let called = false;
		isForeignOneShot(reviewerCall({ tools: [tool] }), () => { called = true; throw new Error("x"); });
		assert.equal(called, false);
	});
});
