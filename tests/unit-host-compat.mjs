import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentText as piContentText } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt as piFormatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { fallbackContentText, fallbackFormatSkillsForPrompt } from "../src/host-compat.js";

// Hosts such as oh-my-pi lack these exports; the fallbacks must match pi's output.
describe("host compat fallbacks", () => {
	it("contentText matches pi-ai", () => {
		const blocks = [
			{ type: "text", text: "first" },
			{ type: "image", data: "x", mimeType: "image/png" },
			{ type: "text", text: "second" },
		];
		assert.equal(fallbackContentText("plain"), piContentText("plain"));
		assert.equal(fallbackContentText(blocks), piContentText(blocks));
		assert.equal(fallbackContentText(blocks, " | "), piContentText(blocks, " | "));
	});

	it("formatSkillsForPrompt matches pi-coding-agent", () => {
		const skills = [
			{ name: "a&b", description: "uses <tags> and \"quotes\"", filePath: "/s/a/SKILL.md", baseDir: "/s/a", source: "user" },
			{ name: "hidden", description: "not for the model", filePath: "/s/h/SKILL.md", baseDir: "/s/h", source: "user", disableModelInvocation: true },
		];
		assert.equal(fallbackFormatSkillsForPrompt(skills), piFormatSkillsForPrompt(skills));
		assert.equal(fallbackFormatSkillsForPrompt([]), piFormatSkillsForPrompt([]));
	});
});
