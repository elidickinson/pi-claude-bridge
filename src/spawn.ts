// The Claude Agent SDK's ProcessTransport (the ^0.2.141 range this package
// depends on) attaches `error`/`exit` listeners to the child process but none
// to `child.stdin`. If the CLI executable exits before reading stdin (e.g.
// pathToClaudeCodeExecutable: /bin/false), the SDK's first stdin.write emits an
// asynchronous `write EPIPE` on the stdin stream, which becomes a process-level
// uncaughtException and kills the host (pi). A CLI that stays alive briefly then
// exits non-zero is fine: the query consumer gets "Claude Code process exited
// with code 1". SDK 0.3.208 added its own stdin error listener
// (anthropics/claude-agent-sdk-typescript#318); this guard is harmless there.
//
// A stdin error only proves the child closed its stdin. If the child is still
// running, the SDK still considers the transport ready and the turn would hang
// instead of failing — so the stdin error listener SIGTERMs a still-running
// child (and SIGKILLs it if it is still alive after `killEscalationMs`), and
// the SDK's own exit listener reports the failure.
//
// This module supplies a spawnClaudeCodeProcess that mirrors the SDK's default
// local spawn (including when to pipe stderr) and absorbs stdin write errors.
// One difference: with DEBUG_CLAUDE_AGENT_SDK enabled and no `stderr` callback,
// the SDK's default spawn copies CLI stderr into the SDK's private debug file;
// this spawn sends it to `log` instead, and the bridge's `log` is a no-op
// unless CLAUDE_BRIDGE_DEBUG is also enabled, so SDK-only debugging drops it.

import { spawn } from "child_process";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_KILL_ESCALATION_MS = 5000;

// Same truthiness as the SDK's env-flag helper: "1"/"true"/"yes"/"on"
// (case-insensitive) are enabled; anything else is disabled.
function envFlagEnabled(value: unknown): boolean {
	if (!value) return false;
	if (typeof value === "boolean") return value;
	const normalized = String(value).toLowerCase().trim();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function makeGuardedSpawn(opts: {
	tag: string;
	stderr?: (data: string) => void;
	log?: (msg: string) => void;
	/** How long to wait after SIGTERM before SIGKILL. Default 5000ms. */
	killEscalationMs?: number;
}): (options: SpawnOptions) => ReturnType<typeof spawn> {
	// Never let logging throw out of the stdin error handler: an exception
	// there would be the same uncaught crash this guard exists to prevent.
	const log = (msg: string) => {
		try { opts.log?.(`[${opts.tag}] ${msg}`); } catch { /* ignore */ }
	};
	const killEscalationMs = opts.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;

	return function spawnClaudeCodeProcess(options: SpawnOptions) {
		const { command, args, cwd, env, signal } = options;
		const stderrMode = (envFlagEnabled(env.DEBUG_CLAUDE_AGENT_SDK) || opts.stderr) ? "pipe" : "ignore";
		const child = spawn(command, args, {
			cwd,
			env,
			signal,
			stdio: ["pipe", "pipe", stderrMode],
			windowsHide: true,
		});
		if (stderrMode === "pipe") {
			child.stderr.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString();
				if (opts.stderr) {
					try { opts.stderr(text); } catch { /* ignore */ }
				} else {
					log(`cli stderr: ${text}`);
				}
			});
		}

		const running = () => child.exitCode === null && child.signalCode === null && child.pid != null;
		// process.kill, not child.kill: child.kill sets `killed` even on a
		// zombie, and the SDK's waitForExit then returns without throwing if
		// exitError is not yet set — swallowing "exited with code 1".
		const signalChild = (sig: NodeJS.Signals): boolean => {
			try {
				process.kill(child.pid as number, sig);
				return true;
			} catch (killErr) {
				const code = (killErr as NodeJS.ErrnoException).code;
				if (code !== "ESRCH") log(`stdin error: ${sig} failed: ${code ?? String(killErr)}`);
				return false;
			}
		};

		// `shutdownStarted` is permanent: stdin can emit `error` more than once
		// and only the first one drives the SIGTERM -> SIGKILL sequence.
		let shutdownStarted = false;
		let escalation: NodeJS.Timeout | undefined;
		child.once("exit", () => {
			if (escalation) clearTimeout(escalation);
			escalation = undefined;
		});
		child.stdin.on("error", (err: NodeJS.ErrnoException) => {
			log(`stdin error: ${err.code ?? err.message}`);
			if (!running() || shutdownStarted) return;
			shutdownStarted = true;
			// `child.killed` only means a signal was already sent (e.g. by the SDK's
			// abort path), not that the child is gone: skip the duplicate SIGTERM
			// but still escalate if the child ignores it.
			if (child.killed) {
				log("stdin error: child already signalled, still running");
			} else {
				if (!signalChild("SIGTERM")) return;
				log("stdin error: child still running, sent SIGTERM");
			}
			escalation = setTimeout(() => {
				escalation = undefined;
				if (!running()) return;
				if (signalChild("SIGKILL")) log(`stdin error: child ignored SIGTERM for ${killEscalationMs}ms, sent SIGKILL`);
			}, killEscalationMs);
			escalation.unref();
		});
		return child;
	};
}
