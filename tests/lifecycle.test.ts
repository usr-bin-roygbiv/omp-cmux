import { describe, expect, test } from "bun:test";

import type { CmuxCommandResult, CmuxRunOptions } from "../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../plugins/cmux/src/lifecycle.ts";

type ExtensionHandler = (event: unknown, context: FakeContext) => void | Promise<void>;
type BusHandler = (payload: unknown) => void;

interface FakeContext {
	hasUI: boolean;
	hasPendingMessages(): boolean;
	sessionManager: { getSessionId(): string };
	setInterval(callback: () => void): Timer;
	clearTimer(timer: Timer): void;
}

interface RunCall {
	argv: string[];
	options: CmuxRunOptions;
}

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

function harness() {
	const handlers = new Map<string, ExtensionHandler[]>();
	const busHandlers = new Map<string, BusHandler[]>();
	const calls: RunCall[] = [];
	let pendingMessages = false;
	const context: FakeContext = {
		hasUI: true,
		hasPendingMessages: () => pendingMessages,
		sessionManager: { getSessionId: () => "session-test" },
		setInterval: callback => callback as unknown as Timer,
		clearTimer: () => undefined,
	};
	const api = {
		on(event: string, handler: ExtensionHandler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		events: {
			on(channel: string, handler: BusHandler) {
				const registered = busHandlers.get(channel) ?? [];
				registered.push(handler);
				busHandlers.set(channel, registered);
				return () => {
					busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter(candidate => candidate !== handler));
				};
			},
		},
	};
	const run = async (argv: readonly string[], options: CmuxRunOptions = {}) => {
		calls.push({ argv: [...argv], options });
		return okResult();
	};
	const dispose = registerCmuxLifecycle(api as never, {
		run,
		env: {
			PATH: process.env.PATH,
			HOSTNAME: "test-host",
			CMUX_WORKSPACE_ID: "workspace-test",
			CMUX_SURFACE_ID: "surface-test",
		},
	});
	return {
		calls,
		dispose,
		setPending(value: boolean) {
			pendingMessages = value;
		},
		async emit(event: string, payload: unknown = { type: event }) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, context);
			await Bun.sleep(0);
		},
		async emitBus(channel: string, payload: unknown) {
			for (const handler of busHandlers.get(channel) ?? []) handler(payload);
			await Bun.sleep(0);
		},
	};
}

function commands(calls: RunCall[], command: string): string[][] {
	return calls.map(call => call.argv).filter(argv => argv[0] === command);
}

function rawMainStatuses(calls: RunCall[]): string[] {
	return commands(calls, "set-status").filter(argv => argv[1]?.startsWith("omp_plugin_")).map(argv => argv[2]!);
}

function mainStatuses(calls: RunCall[]): string[] {
	return rawMainStatuses(calls).map(status => status.replace(/^\d+ agents? · /u, ""));
}

function notifications(calls: RunCall[]): string[][] {
	return commands(calls, "notify");
}

function lastCommandIndex(calls: RunCall[], predicate: (call: RunCall) => boolean): number {
	for (let index = calls.length - 1; index >= 0; index -= 1) {
		if (predicate(calls[index]!)) return index;
	}
	return -1;
}

describe("OMP lifecycle adapter", () => {
	test("activates on the first prompt when plugin loading misses session_start", async () => {
		const testHarness = harness();
		await testHarness.emit("before_agent_start");
		await testHarness.emit("agent_start");
		await testHarness.emit("session_stop", {
			turn_id: 1,
			session_id: "session-test",
			stop_hook_active: false,
			messages: [{ role: "assistant", content: "Finished." }],
		});

		expect(mainStatuses(testHarness.calls)).toEqual(["Idle", "Working", "Thinking", "Done"]);
		expect(notifications(testHarness.calls)).toHaveLength(1);
		expect(notifications(testHarness.calls)[0]).toContain("OMP turn complete");
	});

	test("summarizes the root and live subagents in the workspace status", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("1 agent · Idle");

		await testHarness.emit("before_agent_start");
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("1 agent · Working");

		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			progress: { id: "agent-1", status: "running", currentTool: "edit" },
		});
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("2 agents · Working");

		await testHarness.emitBus("task:subagent:lifecycle", {
			id: "agent-2",
			name: "WorkerTwo",
			status: "parked",
			description: "waiting for review",
		});
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("3 agents · Working");
		expect(commands(testHarness.calls, "set-status").some(argv => argv[2] === "WorkerTwo: waiting for review")).toBe(true);

		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			progress: { id: "agent-1", status: "failed" },
		});
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("2 agents · Working");

		await testHarness.emitBus("task:subagent:lifecycle", {
			id: "agent-2",
			name: "WorkerTwo",
			status: "completed",
		});
		expect(rawMainStatuses(testHarness.calls).at(-1)).toBe("1 agent · Working");
	});

	test("bridges the root session through cmux OMP lifecycle hooks with exact GUI identity", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start", { prompt: "Implement lifecycle" });
		await testHarness.emit("agent_end", { messages: [{ role: "assistant", content: "Finished." }] });
		await testHarness.emit("session_stop", {
			turn_id: 1,
			session_id: "session-test",
			stop_hook_active: false,
			messages: [{ role: "assistant", content: "Finished." }],
		});

		const hookCalls = testHarness.calls.filter(call => call.argv[0] === "hooks");
		expect(hookCalls.map(call => call.argv)).toEqual([
			["hooks", "omp", "session-start"],
			["hooks", "omp", "prompt-submit"],
			["hooks", "omp", "stop"],
		]);
		for (const call of hookCalls) {
			expect(call.options.env).toMatchObject({
				CMUX_WORKSPACE_ID: "workspace-test",
				CMUX_SURFACE_ID: "surface-test",
			});
			const payload = JSON.parse(String(call.options.stdin)) as Record<string, unknown>;
			expect(payload.session_id).toBe("session-test");
			expect(payload.cwd).toBeTruthy();
		}
	});

	test("stops the native GUI lifecycle from session_stop when agent_end is absent", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start", { prompt: "Implement lifecycle" });
		await testHarness.emit("session_stop", {
			turn_id: 1,
			session_id: "session-test",
			stop_hook_active: false,
			messages: [{ role: "assistant", content: "Finished." }],
		});

		expect(testHarness.calls.filter(call => call.argv[0] === "hooks").map(call => call.argv)).toEqual([
			["hooks", "omp", "session-start"],
			["hooks", "omp", "prompt-submit"],
			["hooks", "omp", "stop"],
		]);
	});

	test("routes every primary lifecycle status and only the two allowed notifications", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start");
		await testHarness.emit("agent_start");
		await testHarness.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
		await testHarness.emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", isError: false, result: {} });
		await testHarness.emit("auto_retry_start", { attempt: 2, maxAttempts: 4 });
		await testHarness.emit("auto_retry_end", { success: true, attempt: 2 });
		await testHarness.emit("auto_compaction_start");
		await testHarness.emit("auto_compaction_end", { aborted: false, willRetry: false });
		await testHarness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "mcp.ask" });
		await testHarness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "mcp.ask" });
		await testHarness.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "mcp.ask", isError: false, result: {} });
		await testHarness.emit("agent_end", { messages: [] });
		await testHarness.emit("session_stop", {
			turn_id: 1,
			session_id: "session-test",
			stop_hook_active: false,
			messages: [{ role: "assistant", content: "Finished." }],
		});

		expect(mainStatuses(testHarness.calls)).toEqual([
			"Idle",
			"Working",
			"Thinking",
			"Tool: read",
			"Thinking",
			"Retrying 2/4",
			"Thinking",
			"Compacting",
			"Thinking",
			"Needs input",
			"Thinking",
			"Done",
		]);
		const sent = notifications(testHarness.calls);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toContain("OMP needs your input");
		expect(sent[1]).toContain("OMP turn complete");
		for (const argv of sent) {
			expect(argv).toContain("workspace-test");
			expect(argv).toContain("surface-test");
		}
		const decisionIndex = testHarness.calls.findIndex(call => call.argv.includes("OMP needs your input"));
		expect(testHarness.calls[decisionIndex - 2]?.argv).toEqual([
			"set-status",
			"omp_plugin_surface-test",
			"1 agent · Needs input",
			"--icon",
			"questionmark.circle",
			"--color",
			"#ffd60a",
			"--priority",
			"100",
			"--workspace",
			"workspace-test",
		]);
		expect(testHarness.calls[decisionIndex - 1]?.argv).toEqual([
			"trigger-flash",
			"--workspace",
			"workspace-test",
			"--surface",
			"surface-test",
		]);
	});


	test("settles final GUI status and notification from session_stop without requiring agent_end", async () => {
		const cases = [
			{
				message: { role: "assistant", content: "Finished." },
				status: "Done",
				title: "OMP turn complete",
				subtitle: "Completed",
			},
			{
				message: { role: "assistant", content: "Please choose a deployment." },
				status: "Needs input",
				title: "OMP needs your input",
				subtitle: "Waiting",
			},
			{
				message: { role: "assistant", content: "Cannot comply.", stopReason: "blocked" },
				status: "Needs input",
				title: "OMP turn blocked",
				subtitle: "Blocked",
			},
			{
				message: { role: "assistant", content: "", errorMessage: "provider failed" },
				status: "Error",
				title: "OMP turn failed",
				subtitle: "Error",
			},
			{
				message: { role: "assistant", content: "cancelled", stopReason: "aborted" },
				status: "Stopped",
				title: undefined,
				subtitle: undefined,
			},
		] as const;

		for (const [index, scenario] of cases.entries()) {
			const testHarness = harness();
			await testHarness.emit("session_start");
			await testHarness.emit("before_agent_start");
			await testHarness.emit("agent_start");
			await testHarness.emit("message_start", { message: { role: "assistant" } });
			await testHarness.emit("session_stop", {
				turn_id: index + 1,
				session_id: "session-test",
				stop_hook_active: false,
				messages: [],
				last_assistant_message: scenario.message,
			});

			expect(mainStatuses(testHarness.calls).at(-1)).toBe(scenario.status);
			const sent = notifications(testHarness.calls);
			if (!scenario.title) {
				expect(sent).toEqual([]);
				continue;
			}
			expect(sent).toHaveLength(1);
			expect(sent[0]).toContain(scenario.title);
			expect(sent[0]).toContain(`${scenario.subtitle} · test-host · GUI`);
			const statusIndex = lastCommandIndex(testHarness.calls, call => call.argv[0] === "set-status" && call.argv[1] === "omp_plugin_surface-test");

			const notificationIndex = lastCommandIndex(testHarness.calls, call => call.argv[0] === "notify");
			expect(statusIndex).toBeLessThan(notificationIndex);
		}
	});

	test("mirrors todo and named subagents while deferring completion until the final terminal event", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start");
		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			task: "Implement parser",
			progress: { id: "agent-1", agent: "task", status: "running", currentTool: "edit" },
		});
		await testHarness.emit("tool_execution_start", { toolCallId: "todo-1", toolName: "todo" });
		await testHarness.emit("tool_execution_end", {
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: {
				details: {
					phases: [
						{
							name: "Implementation",
							tasks: [
								{ content: "Implement parser", status: "completed" },
								{ content: "Verify behavior", status: "in_progress" },
							],
						},
					],
				},
			},
		});
		await testHarness.emit("agent_end", { messages: [] });
		expect(notifications(testHarness.calls)).toHaveLength(0);
		expect(mainStatuses(testHarness.calls)).toContain("Waiting for 1 subagent");

		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			progress: { id: "agent-1", agent: "task", status: "completed" },
		});
		await testHarness.emit("session_stop", {
			turn_id: 1,
			session_id: "session-test",
			stop_hook_active: false,
			messages: [{ role: "assistant", content: "Finished." }],
		});
		expect(notifications(testHarness.calls)).toHaveLength(1);
		expect(notifications(testHarness.calls)[0]).toContain("OMP turn complete");
		expect(commands(testHarness.calls, "set-progress")[0]).toEqual([
			"set-progress",
			"0.5000",
			"--label",
			"Implementation: Verify behavior",
			"--workspace",
			"workspace-test",
		]);
		const agentStatuses = commands(testHarness.calls, "set-status").filter(argv => argv[1]?.startsWith("omp_agent_"));
		expect(agentStatuses.some(argv => argv[2] === "WorkerOne: tool: edit")).toBe(true);
		expect(commands(testHarness.calls, "clear-status").some(argv => argv[1]?.startsWith("omp_agent_"))).toBe(true);

		const agentCommandCount = agentStatuses.length;
		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			progress: { id: "agent-1", agent: "task", status: "running", currentTool: "bash" },
		});
		const afterLateEvent = commands(testHarness.calls, "set-status").filter(argv => argv[1]?.startsWith("omp_agent_"));
		expect(afterLateEvent).toHaveLength(agentCommandCount);
	});

	test("does not complete while messages are pending and clears only owned sidebar state on shutdown", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start");
		testHarness.setPending(true);
		await testHarness.emit("agent_end", { messages: [] });
		expect(mainStatuses(testHarness.calls)).toContain("Waiting for messages");
		expect(notifications(testHarness.calls)).toHaveLength(0);

		await testHarness.emit("session_shutdown");
		const cleared = commands(testHarness.calls, "clear-status");
		expect(cleared).toContainEqual(["clear-status", "omp_plugin_surface-test", "--workspace", "workspace-test"]);

		expect(commands(testHarness.calls, "clear-progress")).toContainEqual([
			"clear-progress",
			"--workspace",
			"workspace-test",
		]);
		expect(commands(testHarness.calls, "clear-log")).toHaveLength(0);
	});

	test("stops native GUI lifecycle and clears scoped status on disposal", async () => {
		const testHarness = harness();
		await testHarness.emit("session_start");
		await testHarness.emit("before_agent_start", { prompt: "Dispose active turn" });
		await testHarness.emitBus("task:subagent:progress", {
			agent: "WorkerOne",
			progress: { id: "agent-1", status: "running", currentTool: "edit" },
		});

		await testHarness.dispose();
		const hookCommands = testHarness.calls.filter(call => call.argv[0] === "hooks").map(call => call.argv);
		expect(hookCommands.at(-1)).toEqual(["hooks", "omp", "stop"]);
		const cleared = commands(testHarness.calls, "clear-status");
		expect(cleared).toContainEqual(["clear-status", "omp_plugin_surface-test", "--workspace", "workspace-test"]);
		expect(cleared).toContainEqual(["clear-status", "omp_agent_surface-test_agent-1", "--workspace", "workspace-test"]);
	});


	test("fails closed when cmux routing identity is unavailable", async () => {
		const calls: string[][] = [];
		const handlers = new Map<string, ExtensionHandler>();
		const api = {
			on(event: string, handler: ExtensionHandler) {
				handlers.set(event, handler);
			},
			events: { on: () => undefined },
		};
		registerCmuxLifecycle(api as never, {
			run: async argv => {
				calls.push([...argv]);
				return okResult();
			},
			env: { PATH: process.env.PATH },
		});
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			{
				hasUI: true,
				hasPendingMessages: () => false,
				sessionManager: { getSessionId: () => "session-test" },
				setInterval: callback => callback as unknown as Timer,
				clearTimer: () => undefined,
			},
		);
		await Bun.sleep(0);
		expect(calls).toEqual([]);
	});
});
