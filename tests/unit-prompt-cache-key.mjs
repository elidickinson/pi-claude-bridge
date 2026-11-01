import { it } from "node:test";
import assert from "node:assert/strict";
import { PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";

const input = (custom) => ({ custom, contextFiles: [], skills: [] });
const rebuilt = (key) => Buffer.from(key, "utf16le").toString("utf16le");

it("independently rebuilt lookup keys refresh recency without replacing the capture", () => {
	const cache = new PromptCaptures(2);
	const key = "assembled \ud800\u0000\udfff 😀".repeat(2000);
	cache.record(key, input("portable rules"));
	const original = cache.resolve(key);
	cache.record("second", input("second rules"));
	assert.equal(cache.resolve(rebuilt(key)), original);
	assert.equal(cache.resolveOrDerive(rebuilt(key)), original);
	cache.record("third", input("third rules"));
	assert.equal(cache.size, 2);
	assert.equal(cache.resolve("second"), undefined);
	assert.equal(cache.resolve(rebuilt(key)), original);
	assert.equal(original.assembledPrompt, key);
	assert.equal(projectPromptCapture(original, { skillReadTool: "mcp" }), "portable rules");
});

it("rebuilt keys revive an inherited parent and subsequent records update the same node", () => {
	const cache = new PromptCaptures(2);
	const key = "assembled parent";
	cache.record(key, input("old rules"));
	const parent = cache.resolve(key);
	const childKey = `wrapper ${key} child rules`;
	cache.record(childKey, input(childKey));
	const child = cache.resolve(childKey);
	cache.record("other", input("unrelated rules"));
	assert.equal(cache.resolve(key), undefined);
	assert.equal(cache.resolveOrDerive(rebuilt(key)), parent);
	assert.equal(cache.size, 2);
	cache.record(rebuilt(key), input("new rules"), "turn_start");
	assert.equal(cache.resolve(key), parent);
	assert.equal(parent.source, "turn_start");
	assert.equal(child.inherited[0].parent, parent);
	assert.equal(projectPromptCapture(child, { skillReadTool: "mcp" }), "wrapper new rules child rules");
});
