import { expect, test } from "bun:test";

import { parseCmuxJson, runCmux } from "../../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../../plugins/cmux/src/lifecycle.ts";

const socket = process.env.CMUX_TUI_SOCKET;
const surface = process.env.CMUX_TUI_SURFACE_ID;
const liveTest = process.env.CMUX_TUI_LIFECYCLE_INTEGRATION === "1" && socket && surface ? test : test.skip;

interface LiveContext {
	hasUI: boolean;
	hasPendingMessages(): boolean;
	sessionManager: { getSessionId(): string };
	setInterval(callback: () => void, ms?: number): Timer;
	clearTimer(timer: Timer): void;
}

type Handler = (event: unknown, context: LiveContext) => void | Promise<void>;
const context: LiveContext = {
	hasUI: true,
	hasPendingMessages: () => false,
	sessionManager: { getSessionId: () => "omp-cmux-live-probe" },
	setInterval(callback: () => void, ms = 1_000) {
		const timer = setInterval(callback, ms);
		timer.unref();
		return timer;
	},
	clearTimer(timer: Timer) {
		clearInterval(timer);
	},
};

liveTest(
	"reports lifecycle state and native notifications to a live cmux TUI surface",
	async () => {
		const handlers = new Map<string, Handler[]>();
		const busHandlers = new Map<string, Array<(payload: unknown) => void>>();
		const api = {
			on(event: string, handler: Handler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			events: {
				on(channel: string, handler: (payload: unknown) => void) {
					const registered = busHandlers.get(channel) ?? [];
					registered.push(handler);
					busHandlers.set(channel, registered);
					return () => undefined;
				},
			},
		};
		const env = { ...process.env };
		const run = (args: readonly string[], options = {}) => runCmux(args, { ...options, env });
		const dispose = registerCmuxLifecycle(api as never, { env, run });
		const emit = async (event: string, payload: unknown = { type: event }) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, context);
		};
		const emitBus = (channel: string, payload: unknown) => {
			for (const handler of busHandlers.get(channel) ?? []) handler(payload);
		};
		const listAgent = async () => {
			const result = await runCmux(["--json", "list-agents", "--surface", surface!], { binary: process.env.CMUX_OMP_TUI_BINARY ?? "cmux-tui", env });
			expect(result.ok, result.stderr || result.error?.message).toBe(true);
			const parsed = parseCmuxJson<{ agents?: Array<Record<string, unknown>> }>(result.stdout);
			return parsed.agents?.[0];
		};
		const waitFor = async (predicate: (agent: Record<string, unknown>) => boolean) => {
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const agent = await listAgent();
				if (agent && predicate(agent)) return agent;
				await Bun.sleep(50);
			}
			throw new Error("cmux TUI agent report did not reach the expected state");
		};

		try {
			await emit("session_start");
			await waitFor(agent => agent.state === "idle" && agent.session === "omp-cmux-live-probe");
			await emit("before_agent_start", { prompt: "Live TUI lifecycle probe" });
			await emit("tool_execution_end", {
				toolCallId: "todo-live",
				toolName: "todo",
				isError: false,
				result: { details: { phases: [{ name: "Probe", tasks: [{ content: "Start", status: "completed" }, { content: "Finish", status: "in_progress" }] }] } },
			});
			emitBus("task:subagent:progress", { agent: "LiveWorker", progress: { id: "live-agent", status: "running", currentTool: "read" } });
			const working = await waitFor(agent => agent.state === "working" && agent.session === "omp-cmux-live-probe");
			expect(working.surface).toBe(Number(surface));
			expect(working.source).toBe("socket");
			expect(typeof working.updated_at_ms).toBe("number");
			await emit("tool_execution_start", { toolCallId: "ask-live", toolName: "ask" });
			await emit("session_stop", {
				turn_id: 1,
				session_id: "omp-cmux-live-probe",
				stop_hook_active: false,
				messages: [{ role: "assistant", content: "Probe complete." }],
			});
			await waitFor(agent => agent.state === "done");
		} finally {
			await dispose();
		}
	},
	30_000,
);
