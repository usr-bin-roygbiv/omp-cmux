import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";

import type { CmuxCommandResult, CmuxRunOptions } from "../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../plugins/cmux/src/lifecycle.ts";

interface RunCall {
	argv: string[];
	options: CmuxRunOptions;
}

interface EntryCall {
	type: string;
	data: unknown;
}

type Handler = (event: any, context: any) => void | Promise<void>;

function okResult(): CmuxCommandResult {
	return {
		ok: true,
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		aborted: false,
		truncated: { stdout: false, stderr: false },
	};
}

function lifecycleHarness(env: NodeJS.ProcessEnv, options: { hasUI?: boolean; now?: number } = {}) {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const calls: RunCall[] = [];
	const entries: EntryCall[] = [];
	const intervals = new Set<() => void>();
	let pending = false;
	const sessionManager = { getSessionId: () => "session-42" };
	const context = {
		hasUI: options.hasUI ?? true,
		hasPendingMessages: () => pending,
		sessionManager,
		setInterval(callback: () => void) {
			intervals.add(callback);
			return callback as unknown as Timer;
		},
		clearTimer(timer: Timer) {
			intervals.delete(timer as unknown as () => void);
		},
	};
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
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	const run = async (argv: readonly string[], runOptions: CmuxRunOptions = {}) => {
		calls.push({ argv: [...argv], options: runOptions });
		return okResult();
	};
	const dispose = registerCmuxLifecycle(api as never, { env, run, now: () => options.now ?? 1_700_000_000_000 });
	return {
		calls,
		entries,
		intervals,
		dispose,
		setPending(value: boolean) {
			pending = value;
		},
		async emit(event: string, payload: unknown = { type: event }, overrideContext = context) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, overrideContext);
			await Bun.sleep(0);
		},
		async emitBus(channel: string, payload: unknown) {
			for (const handler of busHandlers.get(channel) ?? []) handler(payload);
			await Bun.sleep(0);
		},
		async tick() {
			for (const callback of [...intervals]) callback();
			await Bun.sleep(0);
		},
	};
}

function tuiCalls(harness: ReturnType<typeof lifecycleHarness>, command: string): RunCall[] {
	return harness.calls.filter(call => call.options.binary === "cmux-tui" && call.argv[0] === command);
}

function guiCalls(harness: ReturnType<typeof lifecycleHarness>, command: string): RunCall[] {
	return harness.calls.filter(call => call.options.binary !== "cmux-tui" && call.argv[0] === command);
}

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

async function flush(harness: ReturnType<typeof lifecycleHarness>) {
	await Bun.sleep(0);
	await harness.tick();
}

afterEach(() => {
	AsyncJobManager.resetForTests();
});

describe("TUI lifecycle backend", () => {
	test("routes numeric TUI reports with session time, todo, jobs, and root plus live-agent stats", async () => {
		let releaseJob!: () => void;
		const manager = new AsyncJobManager({ onJobComplete: () => undefined, retentionMs: 0 });
		AsyncJobManager.setInstance(manager);
		manager.register("bash", "background build", async () => {
			await new Promise<void>(resolve => {
				releaseJob = resolve;
			});
			return "done";
		});

		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "17", CMUX_TUI_WORKSPACE_ID: "3" },
			{ now: 1_700_000_000_123 },
		);
		await harness.emit("session_start");
		await harness.emit("before_agent_start", { prompt: "Implement telemetry" });
		await harness.emit("tool_execution_end", {
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: {
				details: {
					phases: [{ name: "Build", tasks: [{ content: "Done", status: "completed" }, { content: "Verify", status: "in_progress" }] }],
				},
			},
		});
		await harness.emitBus("task:subagent:progress", {
			agent: "Worker",
			progress: { id: "agent-1", status: "running", currentTool: "edit" },
		});
		await flush(harness);

		const reports = tuiCalls(harness, "report-agent");
		expect(reports.length).toBeGreaterThan(0);
		const report = reports.at(-1)!.argv;
		expect(report.slice(0, 5)).toEqual(["report-agent", "--surface", "17", "--state", "working"]);
		expect(option(report, "--source")).toBe("socket");
		expect(option(report, "--session")).toBe("session-42");
		expect(option(report, "--started-at-ms")).toBe("1700000000123");
		expect(option(report, "--tasks-completed")).toBe("1");
		expect(option(report, "--tasks-total")).toBe("2");
		expect(option(report, "--jobs-running")).toBe("1");
		expect(option(report, "--agents-active")).toBe("2");
		expect(option(report, "--detail")).toContain("Worker");
		expect(option(report, "--detail")).toContain("Build: Verify");
		expect(guiCalls(harness, "set-status")).toEqual([]);
		expect(harness.intervals).toHaveLength(1);

		releaseJob();
		await manager.dispose();
		await harness.dispose();
	});

	test("gates all lifecycle effects to the root UI and owns one timer cleared on stop and shutdown", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "9" },
			{ hasUI: false },
		);
		await harness.emit("session_start");
		await harness.emit("before_agent_start", { prompt: "headless" });
		await harness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
		expect(harness.calls).toEqual([]);
		expect(harness.intervals).toHaveLength(0);

		const rootContext = {
			hasUI: true,
			hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => "session-42" },
			setInterval(callback: () => void) {
				harness.intervals.add(callback);
				return callback as unknown as Timer;
			},
			clearTimer(timer: Timer) {
				harness.intervals.delete(timer as unknown as () => void);
			},
		};
		await harness.emit("session_start", { type: "session_start" }, rootContext);
		expect(harness.intervals).toHaveLength(1);
		await harness.emit("session_stop", { turn_id: 1, session_id: "session-42", stop_hook_active: false, messages: [] }, rootContext);
		expect(harness.intervals).toHaveLength(0);
		await harness.emit("before_agent_start", { prompt: "next turn" }, rootContext);
		expect(harness.intervals).toHaveLength(1);
		await harness.emit("session_shutdown", { type: "session_shutdown" }, rootContext);
		expect(harness.intervals).toHaveLength(0);
		await harness.dispose();
	});
});

describe("semantic notifications", () => {
	test("uses native TUI notify for ask, approval, successful plan, and classified final outcomes with exact dedupe", async () => {
		const harness = lifecycleHarness({ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "5" });
		await harness.emit("session_start");
		await harness.emit("before_agent_start", { prompt: "First prompt" });
		await harness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "mcp.ask" });
		await harness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "mcp.ask" });
		await harness.emit("tool_approval_requested", { sessionId: "session-42", toolCallId: "approval-1", toolName: "bash", reason: "exec" });
		await harness.emit("tool_approval_requested", { sessionId: "session-42", toolCallId: "approval-1", toolName: "bash", reason: "exec" });
		const proposal = {
			toolCallId: "plan-1",
			toolName: "write",
			isError: false,
			result: { details: { xdev: { tool: "propose", mode: "execute", inner: { planExists: true, planFilePath: "/tmp/plan.md", title: "Plan" } } } },
		};
		await harness.emit("tool_execution_end", proposal);
		await harness.emit("tool_execution_end", proposal);
		await harness.emit("session_stop", {
			turn_id: 7,
			session_id: "session-42",
			stop_hook_active: false,
			messages: [],
			last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Please choose a deployment." }] },
		});
		await harness.emit("session_stop", {
			turn_id: 7,
			session_id: "session-42",
			stop_hook_active: false,
			messages: [],
			last_assistant_message: { role: "assistant", content: [{ type: "text", text: "Please choose a deployment." }] },
		});
		await flush(harness);

		const notifications = tuiCalls(harness, "notify").map(call => call.argv);
		expect(notifications).toHaveLength(4);
		expect(notifications.map(argv => option(argv, "--title"))).toEqual([
			"OMP needs your input",
			"OMP needs tool approval",
			"OMP plan ready",
			"OMP needs your input",
		]);
		expect(notifications.map(argv => option(argv, "--subtitle"))).toEqual([
			"Waiting",
			"Permission",
			"Plan Ready",
			"Waiting",
		]);
		for (const argv of notifications) expect(option(argv, "--surface")).toBe("5");
		await harness.dispose();
	});

	test("classifies completion, blocked, and error settlements and suppresses aborted or stop-hook-owned turns", async () => {
		const cases = [
			[{ role: "assistant", content: "All done." }, "OMP turn complete", "info", "Completed"],
			[{ role: "assistant", content: "Cannot comply.", stopReason: "blocked" }, "OMP turn blocked", "warning", "Blocked"],
			[{ role: "assistant", content: "", errorMessage: "provider failed" }, "OMP turn failed", "error", "Error"],
		] as const;
		for (let index = 0; index < cases.length; index += 1) {
			const harness = lifecycleHarness({ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "4" });
			await harness.emit("session_start");
			await harness.emit("before_agent_start", { prompt: `prompt-${index}` });
			await harness.emit("session_stop", {
				turn_id: index + 1,
				session_id: "session-42",
				stop_hook_active: false,
				messages: [],
				last_assistant_message: cases[index]![0],
			});
			await flush(harness);
			const notification = tuiCalls(harness, "notify").at(-1)!.argv;
			expect(option(notification, "--title")).toBe(cases[index]![1]);
			expect(option(notification, "--level")).toBe(cases[index]![2]);
			expect(option(notification, "--subtitle")).toBe(cases[index]![3]);
			await harness.dispose();
		}

		const suppressed = lifecycleHarness({ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "4" });
		await suppressed.emit("session_start");
		await suppressed.emit("session_stop", {
			turn_id: 10,
			session_id: "session-42",
			stop_hook_active: false,
			messages: [],
			last_assistant_message: { role: "assistant", stopReason: "aborted", content: "cancelled" },
		});
		await suppressed.emit("session_stop", {
			turn_id: 11,
			session_id: "session-42",
			stop_hook_active: true,
			messages: [],
			last_assistant_message: { role: "assistant", content: "done" },
		});
		await flush(suppressed);
		expect(tuiCalls(suppressed, "notify")).toEqual([]);
		await suppressed.dispose();
	});

	test("persists the existing remote-tmux session entry fallback instead of invoking either backend", async () => {
		const harness = lifecycleHarness({ PATH: process.env.PATH, TMUX: "/tmp/tmux,1,0" });
		await harness.emit("session_start");
		await harness.emit("tool_approval_requested", { sessionId: "session-42", toolCallId: "approval-9", toolName: "bash" });
		await harness.emit("tool_approval_requested", { sessionId: "session-42", toolCallId: "approval-9", toolName: "bash" });
		expect(harness.calls).toEqual([]);
		expect(harness.entries).toHaveLength(1);
		expect(harness.entries[0]).toMatchObject({
			type: "cmux_remote_notification_v1",
			data: { version: 1, kind: "approval", eventId: "session-42:approval:approval-9", sessionId: "session-42", message: "OMP needs tool approval" },
		});
		await harness.dispose();
	});
});

describe("GUI regression", () => {
	test("retains exact GUI status and notify routing when the TUI socket is absent", async () => {
		const harness = lifecycleHarness({ PATH: process.env.PATH, CMUX_WORKSPACE_ID: "workspace-gui", CMUX_SURFACE_ID: "surface-gui" });
		await harness.emit("session_start");
		await harness.emit("before_agent_start", { prompt: "GUI prompt" });
		await harness.emit("tool_execution_start", { toolCallId: "ask-gui", toolName: "ask" });
		await flush(harness);
		expect(guiCalls(harness, "set-status").some(call => call.argv.includes("workspace-gui"))).toBe(true);
		const notification = guiCalls(harness, "notify").at(-1)!.argv;
		expect(notification).toContain("workspace-gui");
		expect(notification).toContain("surface-gui");
		expect(tuiCalls(harness, "report-agent")).toEqual([]);
		await harness.dispose();
	});
});
