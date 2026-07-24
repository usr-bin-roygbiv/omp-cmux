import { describe, expect, test } from "bun:test";

import type { CmuxCommandResult, CmuxRunOptions } from "../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../plugins/cmux/src/lifecycle.ts";

type ExtensionHandler = (event: unknown, context: FakeContext) => void | Promise<void>;
type BusHandler = (payload: unknown) => void;

interface FakeContext {
	hasPendingMessages(): boolean;
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
	const context: FakeContext = { hasPendingMessages: () => pendingMessages };
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

function mainStatuses(calls: RunCall[]): string[] {
	return commands(calls, "set-status").filter(argv => argv[1] === "omp_plugin").map(argv => argv[2]!);
}

function notifications(calls: RunCall[]): string[][] {
	return commands(calls, "notify");
}

describe("OMP lifecycle adapter", () => {
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
		await testHarness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
		await testHarness.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
		await testHarness.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "ask", isError: false, result: {} });
		await testHarness.emit("agent_end", { messages: [] });

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
		expect(sent[0]).toContain("OMP needs your decision");
		expect(sent[1]).toContain("OMP turn complete");
		for (const argv of sent) {
			expect(argv).toContain("workspace-test");
			expect(argv).toContain("surface-test");
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
		expect(cleared).toContainEqual(["clear-status", "omp_plugin", "--workspace", "workspace-test"]);
		expect(commands(testHarness.calls, "clear-progress")).toContainEqual([
			"clear-progress",
			"--workspace",
			"workspace-test",
		]);
		expect(commands(testHarness.calls, "clear-log")).toHaveLength(0);
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
		await handlers.get("session_start")?.({ type: "session_start" }, { hasPendingMessages: () => false });
		await Bun.sleep(0);
		expect(calls).toEqual([]);
	});
});
