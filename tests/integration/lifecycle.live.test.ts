import { expect, test } from "bun:test";

import { parseCmuxJson, runCmux } from "../../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../../plugins/cmux/src/lifecycle.ts";

const workspaceId = process.env.CMUX_WORKSPACE_ID;
const surfaceId = process.env.CMUX_SURFACE_ID;
const liveTest = process.env.CMUX_LIFECYCLE_INTEGRATION === "1" && workspaceId && surfaceId ? test : test.skip;

type ExtensionHandler = (event: unknown, context: { hasPendingMessages(): boolean }) => void | Promise<void>;
type BusHandler = (payload: unknown) => void;

liveTest(
	"drives live cmux statuses, todo, subagents, and notification gates through the lifecycle adapter",
	async () => {
		const handlers = new Map<string, ExtensionHandler[]>();
		const busHandlers = new Map<string, BusHandler[]>();
		const context = { hasPendingMessages: () => false };
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
					return () => undefined;
				},
			},
		};
		const targetEnv: NodeJS.ProcessEnv = { ...process.env };
		const lifecycleCommands: string[][] = [];
		const lifecycleFailures: string[] = [];
		const lifecycleCompletions: string[] = [];
		const lifecycleRun: typeof runCmux = async (args, options) => {
			lifecycleCommands.push([...args]);
			const result = await runCmux(args, options);
			if (!result.ok) lifecycleFailures.push(result.stderr || result.error?.message || "unknown cmux failure");
			else lifecycleCompletions.push(result.stdout);
			return result;
		};
		const dispose = registerCmuxLifecycle(api as never, { env: targetEnv, run: lifecycleRun });
		const emit = async (event: string, payload: unknown = { type: event }) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, context);
		};
		const emitBus = (channel: string, payload: unknown) => {
			for (const handler of busHandlers.get(channel) ?? []) handler(payload);
		};
		const command = async (args: string[]) => {
			const result = await runCmux(args, { env: targetEnv });
			expect(result.ok, result.stderr || result.error?.message).toBe(true);
			return result.stdout;
		};
		const sidebar = () => command(["sidebar-state", "--workspace", workspaceId!]);
		const waitForSidebar = async (needle: string) => {
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const output = await sidebar();
				if (output.includes(needle)) return output;
				await Bun.sleep(50);
			}
			throw new Error(
				`sidebar never contained ${JSON.stringify(needle)}; lifecycle commands=${JSON.stringify(lifecycleCommands)} completions=${JSON.stringify(lifecycleCompletions)} failures=${JSON.stringify(lifecycleFailures)}`,
			);
		};
		const listedNotifications = async () => {
			const output = await command(["--json", "list-notifications"]);
			const parsed = parseCmuxJson<unknown>(output);
			return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
		};

		await command(["clear-notifications", "--workspace", workspaceId!]);
		try {
			await command(["set-status", "live-probe", "Visible", "--workspace", workspaceId!]);
			await waitForSidebar("  live-probe=Visible");
			await command(["clear-status", "live-probe", "--workspace", workspaceId!]);
			await emit("session_start");
			await waitForSidebar("  omp_plugin=Idle");
			await emit("before_agent_start");
			await waitForSidebar("  omp_plugin=Working");
			await emit("agent_start");
			await waitForSidebar("  omp_plugin=Thinking");
			await emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
			await waitForSidebar("  omp_plugin=Tool: read");
			await emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", isError: false, result: {} });
			await emit("auto_retry_start", { attempt: 1, maxAttempts: 3 });
			await waitForSidebar("  omp_plugin=Retrying 1/3");
			await emit("auto_retry_end", { success: true });
			await emit("auto_compaction_start");
			await waitForSidebar("  omp_plugin=Compacting");
			await emit("auto_compaction_end", { aborted: false, willRetry: false });
			await emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
			await waitForSidebar("  omp_plugin=Needs input");
			await emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
			await emit("tool_execution_end", { toolCallId: "ask-1", toolName: "ask", isError: false, result: {} });

			emitBus("task:subagent:progress", {
				agent: "WorkerOne",
				task: "Verify lifecycle",
				progress: { id: "agent-1", status: "running", currentTool: "edit" },
			});
			await waitForSidebar("WorkerOne: tool: edit");
			await emit("tool_execution_start", { toolCallId: "todo-1", toolName: "todo" });
			await emit("tool_execution_end", {
				toolCallId: "todo-1",
				toolName: "todo",
				isError: false,
				result: {
					details: {
						phases: [
							{
								name: "Verification",
								tasks: [
									{ content: "Start", status: "completed" },
									{ content: "Finish", status: "in_progress" },
								],
							},
						],
					},
				},
			});
			await waitForSidebar("progress=0.50 Verification: Finish");
			await emit("agent_end", { messages: [] });
			await waitForSidebar("  omp_plugin=Waiting for 1 subagent");
			expect((await listedNotifications()).filter(item => item.title === "OMP needs your decision")).toHaveLength(1);
			expect((await listedNotifications()).filter(item => item.title === "OMP turn complete")).toHaveLength(0);

			emitBus("task:subagent:progress", {
				agent: "WorkerOne",
				progress: { id: "agent-1", status: "completed" },
			});
			await waitForSidebar("  omp_plugin=Done");
			const completed = await listedNotifications();
			expect(completed.filter(item => item.title === "OMP turn complete")).toHaveLength(1);

			await emit("before_agent_start");
			await emit("message_end", { message: { role: "assistant", errorMessage: "provider failed" } });
			await emit("agent_end", { messages: [{ role: "assistant", errorMessage: "provider failed" }] });
			await waitForSidebar("  omp_plugin=Error");
			expect((await listedNotifications()).filter(item => item.title === "OMP turn complete")).toHaveLength(1);

			await emit("before_agent_start");
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
			await waitForSidebar("  omp_plugin=Stopped");
			expect((await listedNotifications()).filter(item => item.title === "OMP turn complete")).toHaveLength(1);
		} finally {
			await dispose();
			const cleaned = await waitForSidebar("progress=none");
			expect(cleaned).not.toContain("  omp_plugin=");
			expect(cleaned).not.toContain("  omp_agent_");
			await command(["clear-notifications", "--workspace", workspaceId!]);
		}
	},
	60_000,
);
