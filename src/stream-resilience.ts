export type FailureClass = "rate-limit" | "transient" | "fatal";

const FATAL_PATTERN =
	/\b(401|403)\b|authentication|unauthenticated|unauthorized|invalid[ _-]?api[ _-]?key|api[ _-]?key not|oauth|please (log|sign) ?in|credential|permission denied|forbidden|not permitted|payment|billing|insufficient[ _](quota|funds|credits?)|credit balance|out of budget|quota exceeded/i;
const TRANSIENT_PATTERN =
	/temporarily limiting requests|not your usage limit|overloaded|\b(429|500|502|503|504|524|529)\b|service unavailable|server error|internal error|rate limited|too many requests|ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN|socket hang up|fetch failed|premature close|other side closed|stream (ended|closed) (before|without)|ended without|timed out|timeout|network error|connection (error|refused|reset|lost)/i;
const SUBSCRIPTION_LIMIT_PATTERN =
	/you('?ve|'?re| have)? ?(hit|reached) your [^.\n]*limit|usage limit reached|\blimits?\b[^.\n]{0,60}\bresets?\b/i;
const PI_NON_RETRYABLE_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

export const RATE_LIMIT_PREFIX = "Rate limit (429) from Claude Code";
const RATE_LIMIT_FALLBACK_DETAIL = "subscription or plan limit reached";

export function rateLimitMessage(detail: string): string {
	const trimmed = detail.trim();
	if (trimmed.startsWith(RATE_LIMIT_PREFIX)) return trimmed;
	if (!trimmed || PI_NON_RETRYABLE_PATTERN.test(trimmed)) {
		return `${RATE_LIMIT_PREFIX}: ${RATE_LIMIT_FALLBACK_DETAIL}`;
	}
	return `${RATE_LIMIT_PREFIX}: ${trimmed}`;
}

export interface ClassifiedFailure {
	kind: FailureClass;
	message: string;
}

export function classifyFailure(text: string, rateLimitRejected = false): ClassifiedFailure {
	const message = (text ?? "").trim();
	if (message && FATAL_PATTERN.test(message)) return { kind: "fatal", message };
	if (rateLimitRejected) return { kind: "rate-limit", message: rateLimitMessage(message) };
	if (message && TRANSIENT_PATTERN.test(message) && !SUBSCRIPTION_LIMIT_PATTERN.test(message)) {
		return { kind: "transient", message };
	}
	if (message && SUBSCRIPTION_LIMIT_PATTERN.test(message)) {
		return { kind: "rate-limit", message: rateLimitMessage(message) };
	}
	return { kind: "fatal", message };
}

export const TRANSIENT_RETRY_DELAY_MS = 800;
const MAX_TRANSIENT_RETRIES = 1;

export interface RetryDecision {
	retry: boolean;
	reason: string;
	kind: FailureClass;
	message: string;
}

export function decideRetry(input: {
	failure: unknown;
	rateLimitRejected?: boolean;
	outputStarted: boolean;
	retriesUsed: number;
	aborted?: boolean;
}): RetryDecision {
	const text = input.failure instanceof Error ? input.failure.message : String(input.failure ?? "");
	const classified = input.failure instanceof StreamStalledError
		? { kind: "transient" as FailureClass, message: text }
		: classifyFailure(text, input.rateLimitRejected ?? false);
	const decision = (retry: boolean, reason: string): RetryDecision => ({ retry, reason, kind: classified.kind, message: classified.message });

	if (input.aborted) return decision(false, "aborted");
	if (classified.kind !== "transient") return decision(false, `${classified.kind} failure is never retried`);
	if (input.outputStarted) return decision(false, "output already started");
	if (input.retriesUsed >= MAX_TRANSIENT_RETRIES) return decision(false, "retry budget exhausted");
	return decision(true, "transient failure before any output");
}

export class StreamStalledError extends Error {
	constructor(idleMs: number) {
		super(`Claude Code stream stalled: no SDK events for ${Math.round(idleMs / 1000)}s with no tool call in flight, request timed out`);
		this.name = "StreamStalledError";
	}
}

export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

export function stallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_STALL_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_STALL_TIMEOUT_MS;
	return parsed > 0 ? parsed : 0;
}

interface RateLimitInfo {
	status?: string;
	overageStatus?: string;
}

export interface StreamMonitorOptions {
	idleMs: number;
	hasPendingWork: () => boolean;
	onStall: (error: StreamStalledError) => void;
	log?: (message: string) => void;
}

export class StreamMonitor {
	stalled = false;
	stallError: StreamStalledError | undefined;
	rateLimitRejected = false;

	private timer: ReturnType<typeof setTimeout> | undefined;
	private finished = false;

	constructor(private readonly options: StreamMonitorOptions) {}

	arm(): void {
		if (this.finished || this.options.idleMs <= 0) return;
		this.disarm();
		this.timer = setTimeout(() => this.fire(), this.options.idleMs);
		this.timer.unref?.();
	}

	onSdkEvent(type?: string): void {
		if (type === "result") this.stop();
		else this.arm();
	}

	noteRateLimitEvent(info: RateLimitInfo | undefined): void {
		this.rateLimitRejected = info?.status === "rejected" || info?.overageStatus === "rejected";
	}

	stop(): void {
		this.finished = true;
		this.disarm();
	}

	private disarm(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private fire(): void {
		this.timer = undefined;
		if (this.finished) return;
		if (this.options.hasPendingWork()) {
			this.options.log?.("stall watchdog: tool call in flight, re-arming");
			this.arm();
			return;
		}
		this.finished = true;
		this.stalled = true;
		this.stallError = new StreamStalledError(this.options.idleMs);
		this.options.log?.(`stall watchdog: ${this.stallError.message}`);
		this.options.onStall(this.stallError);
	}
}
