import { expect, test } from "bun:test";

import { parseCmuxJson, runCmux } from "../../plugins/cmux/src/cmux.ts";
import { registerCmuxLifecycle } from "../../plugins/cmux/src/lifecycle.ts";

const workspaceId = process.env.CMUX_WORKSPACE_ID;
const surfaceId = process.env.CMUX_SURFACE_ID;
const liveTest = process.env.CMUX_LIFECYCLE_INTEGRATION === "1" && workspaceId && surfaceId ? test : test.skip;
const statusSurface = (surfaceId ?? "unknown").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "unknown";
const mainStatusKey = `omp_plugin_${statusSurface}`;
const countStatusKey = `omp_group_${statusSurface}_counts`;

interface LiveContext {
	hasUI: boolean;
	hasPendingMessages(): boolean;
	sessionManager: { getSessionId(): string };
	setInterval(callback: () => void, ms?: number): Timer;
	clearTimer(timer: Timer): void;
}

type ExtensionHandler = (event: unknown, context: LiveContext) => void | Promise<void>;
type BusHandler = (payload: unknown) => void;

liveTest(
	"drives live cmux statuses, todo, subagents, and notification gates through the lifecycle adapter",
	async () => {
		const handlers = new Map<string, ExtensionHandler[]>();
		const busHandlers = new Map<string, BusHandler[]>();
		const context: LiveContext = {
			hasUI: true,
			hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => "omp-cmux-gui-live-probe" },
			setInterval(callback, ms = 1_000) {
				const timer = setInterval(callback, ms);
				timer.unref();
				return timer;
			},
			clearTimer: timer => clearInterval(timer),
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
					return () => undefined;
				},
			},
		};
		const targetEnv: NodeJS.ProcessEnv = { ...process.env };
		targetEnv.PI_MACHINE_NAME = `gui-live-probe-${process.pid}`;
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
		const initialNotificationIds = new Set<string>();
		const notificationId = (item: Record<string, unknown>) => typeof item.id === "string" ? item.id : typeof item.notification_id === "string" ? item.notification_id : undefined;
		for (const item of await listedNotifications()) {
			const id = notificationId(item);
			if (id) initialNotificationIds.add(id);
		}
		const newNotifications = (items: Array<Record<string, unknown>>) => items.filter(item => {
			const id = notificationId(item);
			return id !== undefined && !initialNotificationIds.has(id);
		});
		const waitForNotificationCount = async (title: string, expected: number) => {
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const notifications = newNotifications(await listedNotifications());
				if (notifications.filter(item => item.title === title).length === expected) return notifications;
			}
			throw new Error(`notification ${JSON.stringify(title)} never reached count ${expected}; failures=${JSON.stringify(lifecycleFailures)} commands=${JSON.stringify(lifecycleCommands.slice(-20))}`);
		};

		try {
			await command(["set-status", "live-probe", "Visible", "--workspace", workspaceId!]);
			await waitForSidebar("  live-probe=Visible");
			await command(["clear-status", "live-probe", "--workspace", workspaceId!]);
			await emit("session_start");
			await waitForSidebar(`  ${mainStatusKey}=Idle`);
			await emit("before_agent_start");
			await waitForSidebar(`  ${mainStatusKey}=Working`);
			await emit("agent_start");
			await waitForSidebar(`  ${mainStatusKey}=Thinking`);
			await emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
			await waitForSidebar(`  ${mainStatusKey}=Tool: read`);
			await emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", isError: false, result: {} });
			await emit("auto_retry_start", { attempt: 1, maxAttempts: 3 });
			await waitForSidebar(`  ${mainStatusKey}=Retrying 1/3`);
			await emit("auto_retry_end", { success: true });
			await emit("auto_compaction_start");
			await waitForSidebar(`  ${mainStatusKey}=Compacting`);
			await emit("auto_compaction_end", { aborted: false, willRetry: false });
			await emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
			await waitForSidebar(`  ${mainStatusKey}=Needs input`);
			await emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask" });
			await emit("tool_execution_end", { toolCallId: "ask-1", toolName: "ask", isError: false, result: {} });

			emitBus("task:subagent:progress", {
				agent: "WorkerOne",
				task: "Verify lifecycle",
				progress: { id: "agent-1", status: "running", currentTool: "edit" },
			});
			await waitForSidebar(`  ${countStatusKey}=Run 2 · Block 0 · Done 0 · Ask 0 · Err 0`);
			await waitForSidebar(`  ${mainStatusKey}=Thinking`);
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
			const compactSidebar = await waitForSidebar("progress=0.33 Tasks 1/3 · 2 run");
			expect(compactSidebar).toContain("status_count=3");
			expect(compactSidebar).not.toContain(`omp_group_${statusSurface}_running=`);
			expect(compactSidebar).not.toContain("format=markdown");
			await emit("agent_end", { messages: [] });
			await waitForSidebar(`  ${mainStatusKey}=Waiting for 1 subagent`);
			await waitForNotificationCount("OMP needs your input", 1);
			expect(newNotifications(await listedNotifications()).filter(item => item.title === "OMP turn complete")).toHaveLength(0);

			emitBus("task:subagent:progress", {
				agent: "WorkerOne",
				progress: { id: "agent-1", status: "completed" },
			});
			await waitForSidebar(`  ${mainStatusKey}=Done`);
			await emit("session_stop", {
				turn_id: 1,
				session_id: "omp-cmux-gui-live-probe",
				stop_hook_active: false,
				messages: [{ role: "assistant", content: "Probe complete." }],
			});
			await waitForNotificationCount("OMP turn complete", 1);
			expect(lifecycleCommands.filter(args => args[0] === "hooks").map(args => args.slice(0, 3))).toEqual([
				["hooks", "omp", "session-start"],
				["hooks", "omp", "prompt-submit"],
				["hooks", "omp", "stop"],
			]);
			expect(lifecycleFailures).toEqual([]);

			await emit("before_agent_start");
			await emit("message_end", { message: { role: "assistant", errorMessage: "provider failed" } });
			await emit("agent_end", { messages: [{ role: "assistant", errorMessage: "provider failed" }] });
			await emit("session_stop", {
				turn_id: 2,
				session_id: "omp-cmux-gui-live-probe",
				stop_hook_active: false,
				messages: [{ role: "assistant", errorMessage: "provider failed" }],
			});
			await waitForSidebar(`  ${mainStatusKey}=Error`);
			await waitForNotificationCount("OMP turn failed", 1);
			const notificationCountAfterFailure = lifecycleCommands.filter(args => args[0] === "notify").length;

			await emit("before_agent_start");
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
			await emit("session_stop", {
				turn_id: 3,
				session_id: "omp-cmux-gui-live-probe",
				stop_hook_active: false,
				messages: [{ role: "assistant", stopReason: "aborted" }],
			});
			await waitForSidebar(`  ${mainStatusKey}=Stopped`);
			expect(lifecycleCommands.filter(args => args[0] === "notify")).toHaveLength(notificationCountAfterFailure);
		} finally {
			await dispose();
			const cleaned = await waitForSidebar("progress=none");
			expect(cleaned).not.toContain(`  ${mainStatusKey}=`);
			expect(cleaned).not.toContain("  omp_agent_");
			expect(cleaned).not.toContain(`  ${countStatusKey}=`);
			for (const item of newNotifications(await listedNotifications())) {
				const id = notificationId(item);
				if (id) await command(["--json", "dismiss-notification", "--id", id]);
			}
		}
	},
	60_000,
);
