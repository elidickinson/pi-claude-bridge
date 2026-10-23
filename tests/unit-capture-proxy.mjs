/**
 * diag/capture-proxy.mjs against a local fake upstream: responses must stream
 * through as they arrive (lifecycle experiments depend on real abort timing), a
 * client disconnect must reach the upstream, and the /q/<route> prefix must be
 * stripped before forwarding and recorded on the request.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const START = sse({ type: "message_start", message: { id: "msg_fake", usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }, input_transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }] } });
const DELTA = sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "café ☕" } });
const TAIL = sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + sse({ type: "message_stop" });

let upstream, proxy, proxyUrl, out;
const seen = []; // { path, closedEarly }
const gates = new Map(); // test name -> resolve, lets a test hold the upstream mid-stream

before(async () => {
	upstream = createServer((req, res) => {
		const record = { path: req.url, closedEarly: false };
		seen.push(record);
		res.on("close", () => { if (!res.writableFinished) record.closedEarly = true; });
		req.resume();
		req.on("end", async () => {
			const test = req.headers["x-test"];
			if (test === "reset") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(START);
				return setTimeout(() => res.destroy(), 30);
			}
			if (test === "error") {
				res.writeHead(529, { "content-type": "application/json", "retry-after": "1" });
				return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			// Split mid-line and mid-UTF-8 character: the observer must reassemble both.
			const bytes = Buffer.from(START + DELTA);
			const cut = bytes.indexOf(Buffer.from("é")) + 1;
			res.write(bytes.subarray(0, 40));
			res.write(bytes.subarray(40, cut));
			res.write(bytes.subarray(cut));
			await new Promise((resolve) => gates.set(test, resolve));
			res.end(TAIL);
		});
	});
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");

	out = mkdtempSync(join(tmpdir(), "proxy-test-"));
	proxy = spawn(process.execPath, ["diag/capture-proxy.mjs", "--port", "0", "--out", out, "--upstream", `http://127.0.0.1:${upstream.address().port}`], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	proxyUrl = await new Promise((resolve, reject) => {
		proxy.stderr.on("data", (d) => {
			log += d;
			const m = log.match(/capture proxy on (http:\/\/127\.0\.0\.1:\d+)/);
			if (m) resolve(m[1]);
		});
		proxy.on("exit", (code) => reject(new Error(`proxy exited ${code}: ${log}`)));
	});
});

after(async () => {
	// It writes its end manifest on SIGTERM; wait for that before removing the dir.
	const exited = once(proxy, "exit");
	proxy.kill("SIGTERM");
	await exited;
	upstream?.close();
	rmSync(out, { recursive: true, force: true });
});

async function indexRow(route) {
	for (let i = 0; i < 100; i++) {
		const file = join(out, "index.jsonl");
		const row = existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.route === route);
		if (row) return row;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`no index row for route ${route}`);
}

async function readUntil(reader, text) {
	const decoder = new TextDecoder();
	let got = "";
	while (!got.includes(text)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`stream ended before ${JSON.stringify(text)}: ${got}`);
		got += decoder.decode(value, { stream: true });
	}
	return got;
}

describe("capture proxy", () => {
	it("streams chunks before the upstream finishes, strips the route, and records usage", async () => {
		const res = await fetch(`${proxyUrl}/q/qA/v1/messages?beta=true`, { method: "POST", headers: { "x-test": "stream", "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
		const reader = res.body.getReader();
		// The upstream is still holding its tail: this resolves only if the proxy forwards early.
		const head = await readUntil(reader, "café ☕");
		assert.ok(!head.includes("message_stop"));
		gates.get("stream")();
		assert.ok((head + await readUntil(reader, "message_stop")).includes("message_stop"));

		assert.equal(seen.find((s) => s.path.startsWith("/v1/messages")).path, "/v1/messages?beta=true");
		const row = await indexRow("qA");
		assert.equal(row.path, "/v1/messages?beta=true");
		assert.equal(row.terminal, "complete");
		assert.equal(row.messageStop, true);
		assert.deepEqual(row.usage, { input: 3, cacheRead: 1000, cacheWrite: 20 });
		assert.equal(row.inputTransformations[0].reason, "prefix_binding_mismatch");
		assert.equal(row.sse.unparsed, 0);
		assert.ok(existsSync(join(out, `req-${String(row.n).padStart(4, "0")}.json`)));
	});

	it("cancels the upstream on client disconnect and keeps partial usage as partial", async () => {
		const controller = new AbortController();
		const res = await fetch(`${proxyUrl}/q/qB/v1/messages`, { method: "POST", headers: { "x-test": "disconnect" }, body: "{}", signal: controller.signal });
		await readUntil(res.body.getReader(), "café");
		controller.abort();
		const row = await indexRow("qB");
		assert.equal(row.terminal, "client-disconnect");
		assert.equal(row.messageStop, false);
		assert.deepEqual(row.usage, { input: 3, cacheRead: 1000, cacheWrite: 20 });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(seen.at(-1).closedEarly, true, "upstream response was not cancelled");
	});

	it("records an upstream reset mid-stream as an upstream error, not a disconnect", async () => {
		const res = await fetch(`${proxyUrl}/q/qD/v1/messages`, { method: "POST", headers: { "x-test": "reset" }, body: "{}" });
		await res.text().catch(() => {});
		const row = await indexRow("qD");
		assert.equal(row.terminal, "upstream-error");
		assert.equal(row.messageStop, false);
	});

	it("passes a non-2xx through with its status, headers and body, and records it", async () => {
		const res = await fetch(`${proxyUrl}/q/qC/v1/messages`, { method: "POST", headers: { "x-test": "error", authorization: "Bearer sk-ant-oat01-SECRETSECRET" }, body: "{}" });
		assert.equal(res.status, 529);
		assert.equal(res.headers.get("retry-after"), "1");
		assert.equal((await res.json()).error.type, "overloaded_error");
		const row = await indexRow("qC");
		assert.equal(row.status, 529);
		assert.equal(row.usage, null);
		const err = readFileSync(join(out, `err-${String(row.n).padStart(4, "0")}.json`), "utf8");
		assert.match(err, /overloaded_error/);
		assert.ok(!err.includes("SECRETSECRET"), "credential material recorded");
	});
});
