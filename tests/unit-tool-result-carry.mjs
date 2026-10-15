/**
 * Carrying Claude Code's own tool_result content across a rebuild
 * (src/tool-result-carry.ts): CC sends some results in a form pi's history cannot
 * reproduce, so a rebuild reuses CC's content — but only where it was derived from
 * the result pi still holds.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";
import { applyCarriedToolResults, collectCarriedToolResults } from "../src/tool-result-carry.js";

const { __test } = await import("../src/index.js");

const PNG = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

/** A user record holding one tool result, as CC writes it. */
const resultRecord = (id, content, extra = {}) => ({
	type: "user", uuid: randomUUID(), parentUuid: null,
	message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...extra }] },
});

const resultsMessage = (...blocks) => [{ role: "user", content: blocks }];

/** CC's notices for an oversized result, naming the file it saved. */
const persistedNotice = (path) =>
	`<persisted-output>\nOutput too large (64.8KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n[\n  {\n...\n</persisted-output>`;
const oversizedNotice = (path) =>
	`Error: result (91,889 characters across 1,500 lines) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\nUse offset and limit parameters to read specific portions of the file.\n`;

describe("collectCarriedToolResults + applyCarriedToolResults", () => {
	const dirs = [];
	afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
	/** A project dir, as `~/.claude/projects/<cwd>` is laid out. */
	const project = () => {
		const dir = mkdtempSync(join(tmpdir(), "tool-result-carry-"));
		dirs.push(dir);
		return dir;
	};
	let projectDir;
	/** A file CC saved for a session in `projectDir`. */
	const saved = (name, text, dir = (projectDir = project())) => {
		const path = join(dir, "11111111-1111-4111-8111-111111111111", "tool-results", name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		return path;
	};
	const collect = (records) => collectCarriedToolResults(records, projectDir ?? project());

	it("carries an image result with CC's trailing source block", () => {
		const cc = [{ type: "text", text: "Read image file [image/png]" }, PNG, { type: "text", text: "[Image: source: /x/tool-results/blob.png]" }];
		const carried = collect([resultRecord("t1", cc)]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: cc.slice(0, 2) });

		assert.deepEqual(applyCarriedToolResults(messages, carried), ["t1"]);
		assert.deepEqual(messages[0].content[0].content, cc);
	});

	it("does not carry an image result whose pi copy changed", () => {
		const cc = [{ type: "text", text: "Read image file [image/png]" }, PNG, { type: "text", text: "[Image: source: /x/tool-results/blob.png]" }];
		const carried = collect([resultRecord("t1", cc)]);
		const rewritten = [{ type: "text", text: "[image redacted]" }];
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: rewritten });

		assert.deepEqual(applyCarriedToolResults(messages, carried), []);
		assert.deepEqual(messages[0].content[0].content, rewritten, "an extension's rewrite of pi's history must win");
	});

	it("carries a <persisted-output> preview when the saved JSON matches pi's result", () => {
		const full = [{ type: "text", text: "a long output" }];
		const notice = persistedNotice(saved("t1.json", JSON.stringify(full, null, 2)));
		const carried = collect([resultRecord("t1", notice)]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: full });

		assert.deepEqual(applyCarriedToolResults(messages, carried), ["t1"]);
		assert.equal(messages[0].content[0].content, notice);
	});

	it("carries a token-limit notice when the saved plain text matches pi's result", () => {
		const notice = oversizedNotice(saved("big.txt", "line 0\nline 1"));
		const carried = collect([resultRecord("t1", notice)]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line 0\nline 1" }] });

		assert.deepEqual(applyCarriedToolResults(messages, carried), ["t1"]);
		assert.equal(messages[0].content[0].content, notice);
	});

	it("does not carry a notice whose saved file is gone", () => {
		const path = saved("big.txt", "line 0");
		rmSync(path);
		const carried = collect([resultRecord("t1", oversizedNotice(path))]);
		assert.equal(carried.size, 0, "the notice would send the model to a missing file");
	});

	it("does not carry a notice whose saved file differs from pi's result", () => {
		const carried = collect([resultRecord("t1", oversizedNotice(saved("big.txt", "line 0")))]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "something else" }] });
		assert.deepEqual(applyCarriedToolResults(messages, carried), []);
	});

	it("does not carry across an is_error mismatch", () => {
		const carried = collect([resultRecord("t1", oversizedNotice(saved("big.txt", "boom")))]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true });
		assert.deepEqual(applyCarriedToolResults(messages, carried), []);
	});

	it("reads a file as a block array only under the .json name CC gives one", () => {
		const text = '[{"type":"text","text":"hi"}]';
		const carried = collect([resultRecord("t1", oversizedNotice(saved("big.txt", text)))]);
		const rewritten = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hi" }] });
		assert.deepEqual(applyCarriedToolResults(rewritten, carried), [], "plain text that happens to parse as JSON is still plain text");
		const verbatim = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] });
		assert.deepEqual(applyCarriedToolResults(verbatim, carried), ["t1"]);
	});

	it("matches a saved MCP-form image against pi's converted image", () => {
		const full = [{ type: "text", text: "big" }, { type: "image", data: PNG.source.data, mimeType: "image/png" }];
		const carried = collect([resultRecord("t1", persistedNotice(saved("t1.json", JSON.stringify(full, null, 2))))]);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "big" }, PNG] });
		assert.deepEqual(applyCarriedToolResults(messages, carried), ["t1"]);
	});

	it("does not read a notice's file outside the project's tool-results dirs", () => {
		const outside = project();
		const stray = join(outside, "stray.txt");
		writeFileSync(stray, "line 0");
		projectDir = project();
		assert.equal(collect([resultRecord("t1", oversizedNotice(stray))]).size, 0);
		assert.equal(collect([resultRecord("t1", oversizedNotice(join(projectDir, "..", "x", "tool-results", "y")))]).size, 0);
		assert.equal(collect([resultRecord("t1", oversizedNotice("/dev/zero"))]).size, 0);
	});

	it("reads only from a session's tool-results dir", () => {
		projectDir = project();
		const other = join(projectDir, "11111111-1111-4111-8111-111111111111", "subagents", "big.txt");
		mkdirSync(dirname(other), { recursive: true });
		writeFileSync(other, "line 0");
		assert.equal(collect([resultRecord("t1", oversizedNotice(other))]).size, 0);
	});

	it("does not read a saved file past the size cap", () => {
		const path = saved("big.txt", "");
		truncateSync(path, 32 * 1024 * 1024 + 1);
		assert.equal(collect([resultRecord("t1", oversizedNotice(path))]).size, 0);
	});

	it("does not read a notice's file through a symlink", () => {
		const outside = project();
		writeFileSync(join(outside, "secret.txt"), "line 0");
		const link = saved("big.txt", "");
		rmSync(link);
		symlinkSync(join(outside, "secret.txt"), link);
		const messages = resultsMessage({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line 0" }] });
		assert.deepEqual(applyCarriedToolResults(messages, collect([resultRecord("t1", oversizedNotice(link))])), []);
	});

	it("leaves ordinary results and sidechain records alone", () => {
		const carried = collect([
			resultRecord("plain", [{ type: "text", text: "ok" }]),
			resultRecord("note", "(mcp__x__t completed with no output)"),
			{ ...resultRecord("side", [PNG, { type: "text", text: "[Image: source: /x.png]" }]), isSidechain: true },
		]);
		assert.equal(carried.size, 0);
	});
});

describe("deleteSessionKeepingToolResults", () => {
	// deleteSession unlinks a symlinked companion dir; reaching through it would
	// delete whatever the link points at.
	it("removes a symlinked companion dir without touching its target", () => {
		const dir = mkdtempSync(join(tmpdir(), "delete-keeping-"));
		try {
			const target = join(dir, "elsewhere");
			mkdirSync(target);
			writeFileSync(join(target, "keep.txt"), "x");
			const jsonlPath = join(dir, "s.jsonl");
			writeFileSync(jsonlPath, "");
			symlinkSync(target, join(dir, "s"));
			__test.deleteSessionKeepingToolResults(jsonlPath);
			assert.ok(!existsSync(jsonlPath));
			assert.ok(!existsSync(join(dir, "s")), "the link itself is removed");
			assert.ok(existsSync(join(target, "keep.txt")), "the link's target was deleted through it");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("syncSharedSession carries tool results", () => {
	afterEach(() => __test.resetSharedSession());

	// An in-place rebuild deletes the session's companion dir, where CC saved the
	// oversized output its notice tells the model to read. The carried notice is only
	// true if that file survives.
	it("keeps CC's notice and its saved file across an in-place rebuild", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-tool-result-carry-"));
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			const savedPath = join(seeded.jsonlPath.replace(/\.jsonl$/, ""), "tool-results", "big.txt");
			mkdirSync(dirname(savedPath), { recursive: true });
			writeFileSync(savedPath, "the full output");
			const subagents = join(dirname(dirname(savedPath)), "subagents");
			mkdirSync(subagents);
			const notice = oversizedNotice(savedPath);
			seeded.importMessages([
				{ role: "user", content: "go" },
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "mcp__custom-tools__big", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: notice }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]);
			seeded.save();
			__test.setSharedSession(null, { sessionId, cursor: 4, cwd, needsRebuild: true });

			const t = Date.now();
			const result = __test.syncSharedSession([
				{ role: "user", content: "go", timestamp: t },
				{ role: "assistant", stopReason: "toolUse", timestamp: t + 1, content: [{ type: "toolCall", id: "toolu_big", name: "big", arguments: {} }] },
				{ role: "toolResult", toolCallId: "toolu_big", toolName: "big", content: [{ type: "text", text: "the full output" }], isError: false, timestamp: t + 2 },
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], timestamp: t + 3 },
				{ role: "user", content: "next", timestamp: t + 4 },
			], cwd);

			assert.equal(result.sessionId, sessionId, "the rebuild must be in place for this to exercise the companion-dir wipe");
			const blocks = openSession({ sessionId, projectPath: cwd }).records
				.flatMap((r) => r.type === "user" && Array.isArray(r.message.content) ? r.message.content : [])
				.filter((b) => b.type === "tool_result");
			assert.deepEqual(blocks.map((b) => b.content), [notice]);
			assert.ok(existsSync(savedPath), "the rebuild deleted the file the carried notice names");
			assert.equal(readFileSync(savedPath, "utf8"), "the full output");
			assert.ok(!existsSync(subagents), "the rest of the companion dir is still wiped");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
