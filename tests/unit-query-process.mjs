import { it } from "node:test";
import assert from "node:assert/strict";
import { QueryProcess } from "../src/query-process.js";

it("a synchronous spawn failure leaves no child, so close resolves exited", { timeout: 2000 }, async () => {
	const child = new QueryProcess();
	assert.throws(() => child.spawn({ command: "", args: [], cwd: process.cwd(), env: process.env, signal: new AbortController().signal }), { code: "ERR_INVALID_ARG_VALUE" });
	child.terminate();
	await child.exited;
});
