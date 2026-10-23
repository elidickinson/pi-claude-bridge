#!/usr/bin/env node
// What does Claude Code hand the SDK when a response stream dies mid-message and
// it repeats the request without streaming ("Error streaming, falling back to
// non-streaming mode")?
//
//   [PROBE_DEAD=tool] node --import tsx diag/probe-nonstreaming-fallback.mjs [cut|stall] [--save FILE]
//
// A local server stands in for the API. Its first main request streams a message
// that gets as far as a thinking block, then dies (`cut`: the socket is destroyed;
// `stall`: nothing more is sent until CC's stream idle watchdog gives up). Its
// second main request, the non-streaming repeat, answers with thinking plus TWO
// tool calls. The third answers with text. Every SDK message the query yields is
// printed in order, so the shape consumeQuery has to cope with can be read off
// directly. --save writes them as JSONL, in the format tests replay.
//
// Costs no API calls and needs no Claude credentials beyond the fake key below.

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createToolServer } from "../src/mcp-server.ts";

const mode = process.argv[2] === "stall" ? "stall" : "cut";
// What the dead stream got through before dying: "thinking" (inside the first block) or "tool" (a finished tool call, then a second cut mid-argument).
const dead = ["tool", "text"].includes(process.env.PROBE_DEAD) ? process.env.PROBE_DEAD : "thinking";
const saveAt = process.argv.indexOf("--save");
const savePath = saveAt === -1 ? null : process.argv[saveAt + 1];
const STALL_WAIT_MS = Number(process.env.PROBE_STALL_WAIT_MS ?? 400_000);

const usage = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 };
const SIGNATURE = "c2lnbmF0dXJl";

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
const fullMessage = (id, content, stop_reason) => ({
	id, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason, stop_sequence: null, usage,
});

const requests = [];
let mainCalls = 0;

const api = createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const url = req.url ?? "";
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
		if (!url.startsWith("/v1/messages") || url.includes("count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ input_tokens: 10 }));
			return;
		}
		const isMain = Array.isArray(body.tools) && body.tools.length > 0;
		const n = isMain ? ++mainCalls : 0;
		requests.push({ url, stream: body.stream === true, model: body.model, tools: body.tools?.length ?? 0, main: n });
		console.error(`[api] ${url} stream=${body.stream} model=${body.model} tools=${body.tools?.length ?? 0} main#${n}`);

		if (!isMain) {
			// Side requests (titles, quota probes): a plain text answer in whichever form was asked for.
			const msg = fullMessage("msg_side", [{ type: "text", text: "ok" }], "end_turn");
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				sse(res, "message_start", { message: { ...msg, content: [] } });
				sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
				sse(res, "content_block_stop", { index: 0 });
				sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
				sse(res, "message_stop", {});
				res.end();
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(msg));
			}
			return;
		}

		if (n === 1) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, "message_start", { message: { ...fullMessage("msg_dead", [], null), usage } });
			if (dead === "text") {
				sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "I'll call both" } });
				if (mode === "cut") setTimeout(() => req.socket.destroy(), 300);
				else setTimeout(() => req.socket.destroy(), STALL_WAIT_MS);
				return;
			}
			sse(res, "content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
			sse(res, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Both files, " } });
			sse(res, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "in parallel." } });
			if (dead === "tool") {
				// The stream got further before dying: a finished thinking block, a finished
				// tool call, then a second tool call cut mid-argument.
				sse(res, "content_block_delta", { index: 0, delta: { type: "signature_delta", signature: SIGNATURE } });
				sse(res, "content_block_stop", { index: 0 });
				sse(res, "content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_dead_alpha", name: "mcp__probe__alpha", input: {} } });
				sse(res, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });
				sse(res, "content_block_stop", { index: 1 });
				sse(res, "content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_dead_beta", name: "mcp__probe__beta", input: {} } });
				sse(res, "content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"x' } });
			}
			if (mode === "cut") setTimeout(() => req.socket.destroy(), 300);
			else setTimeout(() => req.socket.destroy(), STALL_WAIT_MS);
			return;
		}

		const content = n === 2
			? [
				{ type: "thinking", thinking: "Both files, in parallel.", signature: SIGNATURE },
				{ type: "tool_use", id: "toolu_probe_alpha", name: "mcp__probe__alpha", input: {} },
				{ type: "tool_use", id: "toolu_probe_beta", name: "mcp__probe__beta", input: {} },
			]
			: [{ type: "text", text: "done" }];
		const stop = n === 2 ? "tool_use" : "end_turn";
		if (body.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, "message_start", { message: { ...fullMessage(`msg_main_${n}`, [], null), usage } });
			content.forEach((block, index) => {
				sse(res, "content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : block });
				if (block.type === "text") sse(res, "content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
				sse(res, "content_block_stop", { index });
			});
			sse(res, "message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
			sse(res, "message_stop", {});
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(fullMessage(`msg_main_${n}`, content, stop)));
		}
	});
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const port = api.address().port;

const answer = (text) => async () => ({ content: [{ type: "text", text }] });
const schema = { type: "object", properties: {} };
const toolServer = createToolServer("probe", [
	{ name: "alpha", description: "First probe tool.", inputSchema: schema, handler: answer("alpha result") },
	{ name: "beta", description: "Second probe tool.", inputSchema: schema, handler: answer("beta result") },
]);

const configDir = mkdtempSync(join(tmpdir(), "probe-fallback-"));
const messages = [];
const q = query({
	prompt: "Call the alpha and beta tools in parallel, then reply done.",
	options: {
		cwd: configDir,
		env: {
			...process.env,
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
			ANTHROPIC_API_KEY: "sk-ant-api03-probe-not-a-real-key",
			CLAUDE_CONFIG_DIR: configDir,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
		},
		tools: [],
		permissionMode: "bypassPermissions",
		settingSources: [],
		includePartialMessages: true,
		mcpServers: { probe: toolServer },
		model: "claude-sonnet-5-5",
		extraArgs: { "strict-mcp-config": null },
	},
});

const brief = (m) => {
	if (m.type === "stream_event") {
		const e = m.event;
		if (e.type === "content_block_start") return `stream_event content_block_start #${e.index} ${e.content_block.type}${e.content_block.id ? ` ${e.content_block.id}` : ""}`;
		if (e.type === "content_block_delta") return `stream_event content_block_delta #${e.index} ${e.delta.type}`;
		if (e.type === "content_block_stop") return `stream_event content_block_stop #${e.index}`;
		if (e.type === "message_start") return `stream_event message_start ${e.message?.id}`;
		return `stream_event ${e.type}`;
	}
	if (m.type === "assistant") return `ASSISTANT ${m.message.id} [${m.message.content.map((b) => b.type + (b.id ? `:${b.id}` : "")).join(", ")}]`;
	if (m.type === "user") return `user [${(Array.isArray(m.message.content) ? m.message.content : []).map((b) => b.type + (b.tool_use_id ? `:${b.tool_use_id}` : "")).join(", ")}]`;
	return `${m.type}${m.subtype ? `/${m.subtype}` : ""}`;
};

const deadline = setTimeout(() => { console.error("probe: timed out"); void q.interrupt(); }, mode === "stall" ? STALL_WAIT_MS + 120_000 : 120_000);
const t0 = Date.now();
for await (const m of q) {
	messages.push(m);
	if (m.type === "system" && m.subtype !== "init" && m.subtype !== "api_retry" && m.subtype !== "status") continue;
	console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${brief(m)}`);
}
clearTimeout(deadline);
api.close();
console.error(`main requests: ${mainCalls}; requests: ${JSON.stringify(requests)}`);
if (savePath) writeFileSync(savePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
