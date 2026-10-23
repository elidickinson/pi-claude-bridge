// Long-lived streaming-input prompt for query().
//
// The SDK accepts `prompt: AsyncIterable<SDKUserMessage>` and pumps it to the
// CLI's stdin. Keeping that iterable parked for the life of the query lets us
// write a steer to stdin *while* a tool is running, which is what makes CC
// drain it at the next tool boundary (`priority: "next"`) instead of treating
// it as a follow-up turn.
//
// The ack is the load-bearing part. `push()` resolves on the line *after*
// `yield`, and the SDK's pump is `for await (m of stream) { await
// transport.write(m) }` — so resuming past the yield proves the write to stdin
// completed. Callers await that before releasing the MCP tool result, which
// travels back over the same stdin FIFO; winning that race is what guarantees
// CC sees the steer before the tool result.
//
// The drain and the FIFO ordering are CC CLI internals, not SDK contract, so
// this can break under a CC upgrade without any type error.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
	stream: AsyncGenerator<SDKUserMessage>;
	/** Enqueue a message; resolves once the SDK has written it to stdin.
	 *  Rejects (never hangs) if the stream is already ended or failed. */
	push: (msg: SDKUserMessage) => Promise<void>;
	/** Close the input: the generator returns, the SDK closes the CLI's stdin. */
	end: () => void;
	/** Abandon the input, rejecting every queued and in-flight ack. */
	fail: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
	type Item = { msg: SDKUserMessage; resolve: () => void; reject: (e: Error) => void };
	const queue: Item[] = [];
	// The item currently parked at `yield`. Tracked separately so fail() can
	// settle it — a dying CLI may abandon the pump without ever resuming us,
	// and an unsettled ack would wedge tool-result delivery forever.
	let inflight: Item | null = null;
	let wake: (() => void) | null = null;
	let done = false;
	let failure: Error | null = null;

	const kick = () => { wake?.(); wake = null; };

	async function* gen(): AsyncGenerator<SDKUserMessage> {
		try {
			while (true) {
				while (queue.length === 0 && !done && !failure) {
					await new Promise<void>((resolve) => { wake = resolve; });
				}
				if (failure) throw failure;
				const item = queue.shift();
				if (!item) return; // ended and drained
				inflight = item;
				try {
					yield item.msg;
					item.resolve();
				} finally {
					// Reached either normally (no-op, already resolved) or when the
					// pump abandons iteration — a `for await` break/throw calls
					// gen.return(), which resumes the yield as a return.
					item.reject(new Error("prompt stream closed"));
					inflight = null;
				}
			}
		} finally {
			// No consumer left to drain the queue, so nothing would ever settle a
			// later push. Closing here keeps the reject-never-hang contract a
			// property of this module rather than of every call site.
			done = true;
		}
	}

	return {
		stream: gen(),
		push: (msg) => failure || done
			? Promise.reject(failure ?? new Error("prompt stream closed"))
			: new Promise<void>((resolve, reject) => { queue.push({ msg, resolve, reject }); kick(); }),
		end: () => { done = true; kick(); },
		fail: (error) => {
			// First failure wins: the query's `finally` fails the stream a second
			// time with a generic "query ended", which would otherwise mask the
			// real cause its `catch` recorded.
			if (failure) return;
			failure = error;
			queue.splice(0).forEach((item) => item.reject(error));
			inflight?.reject(error);
			kick();
		},
	};
}

/** Ordinary user messages omit `uuid`; steering callers add a fresh one to match
 *  the later replay acknowledgement from CC. */
export function userMessage(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content } as SDKUserMessage["message"],
		parent_tool_use_id: null,
		...(priority ? { priority } : {}),
	};
}
