import { describe, expect, test } from "bun:test";

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
interface HarnessCalls {
	calls: RunCall[];
}

interface TickHarness {
	tick(): Promise<void>;
}


type Handler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

function okResult(stdout = ""): CmuxCommandResult {
	return {
		ok: true,
		exitCode: 0,
		signal: null,
		stdout,
		stderr: "",
		timedOut: false,
		aborted: false,
		truncated: { stdout: false, stderr: false },
	};
}

interface ForwardedNotification {
	title: string;
	body: string;
}

function lifecycleHarness(env: NodeJS.ProcessEnv, options: {
	hasUI?: boolean;
	now?: number;
	jobsRunning?: number;
	pid?: number;
	ppid?: number;
	hostname?: () => string;
	platform?: NodeJS.Platform;
	runResult?: (argv: readonly string[]) => CmuxCommandResult;
	forwardSshNotification?: (notification: ForwardedNotification, options?: { env?: NodeJS.ProcessEnv }) => number;
} = {}) {
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
		getAsyncJobSnapshot: () => ({
			running: Array.from({ length: options.jobsRunning ?? 0 }, (_, index) => ({ id: `bg-${index + 1}` })),
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		}),
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
		if (options.runResult) return options.runResult(argv);
		const surfaceId = env.CMUX_TUI_SURFACE_ID;
		if (surfaceId && argv[0] === "process-info" && option([...argv], "--surface") === surfaceId) {
			return okResult(JSON.stringify({ pid: options.ppid ?? process.ppid }));
		}
		if (surfaceId && argv.includes("list-workspaces")) {
			return okResult(JSON.stringify({
				workspaces: [{ id: Number(env.CMUX_TUI_WORKSPACE_ID ?? "1"), screens: [{ panes: [{ tabs: [{ surface: Number(surfaceId), kind: "pty" }] }] }] }],
			}));
		}
		return okResult();
	};
	const dispose = registerCmuxLifecycle(api as never, {
		env,
		run,
		...(options.now === undefined ? {} : { now: () => options.now! }),
		...(options.pid === undefined ? {} : { pid: options.pid }),
		...(options.ppid === undefined ? {} : { ppid: options.ppid }),
		...(options.hostname === undefined ? {} : { hostname: options.hostname }),
		...(options.platform === undefined ? {} : { platform: options.platform }),
		...(options.forwardSshNotification === undefined ? {} : { forwardSshNotification: options.forwardSshNotification }),
	});
	return {
		context,
		calls,
		entries,
		intervals,
		dispose,
		setPending(value: boolean) {
			pending = value;
		},
		async emit(event: string, payload: unknown = { type: event }, overrideContext = context) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, overrideContext));
			await Promise.resolve();
			return results;
		},
		async emitBus(channel: string, payload: unknown) {
			for (const handler of busHandlers.get(channel) ?? []) handler(payload);
			await Promise.resolve();
		},
		async tick() {
			for (const callback of [...intervals]) callback();
			await Promise.resolve();
		},
	};
}

function tuiCalls(harness: HarnessCalls, command: string): RunCall[] {
	return harness.calls.filter(call => call.options.binary === "cmux-tui" && call.argv[0] === command);
}

function guiCalls(harness: HarnessCalls, command: string): RunCall[] {
	return harness.calls.filter(call => call.options.binary !== "cmux-tui" && call.argv[0] === command);
}

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

async function flush(harness: TickHarness) {
	for (let index = 0; index < 32; index += 1) await Promise.resolve();
	await harness.tick();
	for (let index = 0; index < 32; index += 1) await Promise.resolve();
}


describe("TUI lifecycle backend", () => {
	test("routes numeric TUI reports with session-scoped jobs, Todo, and root plus live-agent stats", async () => {

		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "17", CMUX_TUI_WORKSPACE_ID: "3" },
			{ now: 1_700_000_000_123, jobsRunning: 1 },
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
		expect(option(report, "--source")).toBe("hook");
		expect(report).toContain("--root-session");
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

		await harness.dispose();
	});

	test("falls back to the protocol 10 root report schema when structured root telemetry is rejected", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "20" },
			{
				runResult(argv) {
					if (argv[0] === "process-info") return okResult(JSON.stringify({ pid: process.ppid }));
					if (argv.includes("list-workspaces")) {
						return okResult(JSON.stringify({ workspaces: [{ id: 1, screens: [{ panes: [{ tabs: [{ surface: 20, kind: "pty" }] }] }] }] }));
					}
					if (argv[0] === "report-agent" && argv.includes("--root-session")) {
						return { ...okResult(), ok: false, exitCode: 2, stderr: "unknown flag --root-session" };
					}
					return okResult();
				},
			},
		);

		await harness.emit("session_start");
		await flush(harness);

		const reports = tuiCalls(harness, "report-agent").map(call => call.argv);
		expect(reports).toHaveLength(2);
		expect(reports[0]).toContain("--root-session");
		expect(reports[1]).toEqual([
			"report-agent", "--surface", "20", "--state", "idle", "--source", "hook", "--session", "session-42",
		]);
		await harness.dispose();
	});

	test("discovers an omitted TUI surface only from the current process owner", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_WORKSPACE_ID: "4" },
			{
				pid: 4_101,
				ppid: 4_100,
				now: 1_700_000_000_123,
				hostname: () => "davailocal",
				platform: "linux",
				runResult(argv) {
					if (argv[0] === "ids") {
						return okResult(JSON.stringify({
							ids: [
								{ id: 17, kind: "surface", short_id: "00000h" },
								{ id: 18, kind: "surface", short_id: "00000i" },
							],
						}));
					}
					if (argv[0] === "process-info" && option([...argv], "--surface") === "17") {
						return okResult(JSON.stringify({ pid: 9_999 }));
					}
					if (argv[0] === "process-info" && option([...argv], "--surface") === "18") {
						return okResult(JSON.stringify({ pid: 4_100 }));
					}
					if (argv.includes("list-workspaces")) {
						return okResult(JSON.stringify({ workspaces: [{ id: 4, screens: [{ panes: [{ tabs: [{ surface: 18, kind: "pty" }] }] }] }] }));
					}
					return okResult();
				},
			},
		);

		await harness.emit("session_start");
		await flush(harness);
		const runtimeResults = await harness.emit("before_agent_start", {
			prompt: "Continue work",
			systemPrompt: ["base"],
		});
		expect(runtimeResults).toEqual([{
			systemPrompt: [
				"base",
				"<runtime-environment>\nMachine: davailocal\nOMP interface: cmux TUI\n</runtime-environment>",
				"<cmux-runtime-target>\nMachine: davailocal\nSystem: linux\nBackend: tui\nWorkspace: 4\nSurface/tab: 18\nSurface type: terminal\nTool route: cmux_cli\n</cmux-runtime-target>",
			],
		}]);

		expect(tuiCalls(harness, "ids")).toHaveLength(1);
		expect(tuiCalls(harness, "process-info")).toHaveLength(2);
		const report = tuiCalls(harness, "report-agent").at(-1)!.argv;
		expect(report.slice(0, 5)).toEqual(["report-agent", "--surface", "18", "--state", "working"]);
		expect(option(report, "--source")).toBe("hook");
		expect(option(report, "--session")).toBe("session-42");
		expect(option(report, "--label")).toBe("OMP");
		expect(option(report, "--detail")).toBe("Working");
		expect(option(report, "--started-at-ms")).toBe("1700000000123");
		expect(option(report, "--jobs-running")).toBe("0");
		expect(option(report, "--agents-active")).toBe("1");
		expect(harness.intervals).toHaveLength(1);
		await harness.dispose();
	});

	test("fails closed when more than one TUI surface is owned by the current process", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_WORKSPACE_ID: "4" },
			{
				pid: 4_101,
				ppid: 4_100,
				hostname: () => "davailocal",
				platform: "linux",
				runResult(argv) {
					if (argv[0] === "ids") {
						return okResult(JSON.stringify({
							ids: [
								{ id: 17, kind: "surface", short_id: "00000h" },
								{ id: 18, kind: "surface", short_id: "00000i" },
							],
						}));
					}
					if (argv[0] === "process-info") return okResult(JSON.stringify({ pid: 4_100 }));
					return okResult();
				},
			},
		);

		await harness.emit("session_start");
		await flush(harness);
		const runtimeResults = await harness.emit("before_agent_start", { prompt: "Continue work", systemPrompt: ["base"] });

		expect(tuiCalls(harness, "ids")).toHaveLength(1);
		expect(tuiCalls(harness, "process-info")).toHaveLength(2);
		expect(tuiCalls(harness, "report-agent")).toEqual([]);
		expect(runtimeResults).toEqual([{
			systemPrompt: [
				"base",
				"<runtime-environment>\nMachine: davailocal\nOMP interface: cmux TUI\n</runtime-environment>",
				"<cmux-runtime-target>\nMachine: davailocal\nSystem: linux\nBackend: tui\nWorkspace: unavailable\nSurface/tab: unavailable\nSurface type: unavailable\nTool route: unavailable\n</cmux-runtime-target>",
			],
		}]);
		expect(JSON.stringify(runtimeResults)).not.toContain("/tmp/cmux-tui.sock");
		await harness.dispose();
	});

	test("rejects an invalid injected TUI surface before lifecycle mutation", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "0" },
			{
				runResult(argv) {
					if (argv[0] === "ids") return okResult(JSON.stringify({ ids: [] }));
					return okResult();
				},
			},
		);

		await harness.emit("session_start");
		await flush(harness);
		expect(tuiCalls(harness, "report-agent")).toEqual([]);
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
			getAsyncJobSnapshot: () => ({
				running: [],
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
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

describe("runtime environment context", () => {
	test("preserves inherited runtime environment bytes and appends a distinct exact GUI target", async () => {
		const inheritedRuntime = "<runtime-environment>\nMachine: orchestrator-host\nOMP interface: delegated root  \n</runtime-environment>";
		const harness = lifecycleHarness(
			{
				PATH: process.env.PATH,
				PI_MACHINE_NAME: "zacbook",
				CMUX_WORKSPACE_ID: "workspace-gui",
				CMUX_SURFACE_ID: "surface-gui",
			},
			{
				platform: "darwin",
				runResult(argv) {
					if (argv.includes("identify")) {
						return okResult(JSON.stringify({ caller: { workspace_id: "workspace-gui", surface_id: "surface-gui", surface_type: "terminal" } }));
					}
					return okResult();
				},
			},
		);

		const results = await harness.emit("before_agent_start", {
			prompt: "GUI prompt",
			systemPrompt: ["base", inheritedRuntime],
		});

		expect(results).toEqual([{
			systemPrompt: [
				"base",
				inheritedRuntime,
				"<cmux-runtime-target>\nMachine: zacbook\nSystem: darwin\nBackend: gui\nWorkspace: workspace-gui\nSurface/tab: surface-gui\nSurface type: terminal\nTool route: cmux_surface\n</cmux-runtime-target>",
			],
		}]);
		expect(results[0]).toMatchObject({ systemPrompt: expect.arrayContaining([inheritedRuntime]) });
		expect(harness.calls.some(call => call.argv.join("\0") === ["--json", "--id-format", "both", "identify", "--workspace", "workspace-gui", "--surface", "surface-gui"].join("\0"))).toBe(true);
		await harness.dispose();
	});

	test("binds a GUI surface ref when both-format identity returns the exact ref and UUID", async () => {
		const workspaceId = "E6391A6D-95EA-41CB-9B73-DFA192123FF9";
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, PI_MACHINE_NAME: "zacbook", CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: "surface:483" },
			{
				platform: "darwin",
				runResult(argv) {
					if (argv.includes("identify")) {
						return okResult(JSON.stringify({ caller: {
							workspace_id: workspaceId,
							workspace_ref: "workspace:12",
							surface_id: "CF2DB995-7C1D-47AE-934D-7D9BD1ABAD63",
							surface_ref: "surface:483",
							surface_type: "browser",
						} }));
					}
					return okResult();
				},
			},
		);

		const results = await harness.emit("before_agent_start", { prompt: "Browser target", systemPrompt: ["base"] });
		const serialized = JSON.stringify(results);
		expect(serialized).toContain(`Workspace: ${workspaceId}`);
		expect(serialized).toContain("Surface/tab: surface:483");
		expect(serialized).toContain("Surface type: browser");
		expect(serialized).toContain("Tool route: cmux_browser");
		await harness.dispose();
	});

	test("retries GUI exact identity after a transient preflight failure", async () => {
		let identifyAttempts = 0;
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, PI_MACHINE_NAME: "zacbook", CMUX_WORKSPACE_ID: "workspace-gui", CMUX_SURFACE_ID: "surface-gui" },
			{
				platform: "darwin",
				runResult(argv) {
					if (argv.includes("identify")) {
						identifyAttempts += 1;
						if (identifyAttempts === 1) return { ...okResult(), ok: false, exitCode: 1, stderr: "not ready" };
						return okResult(JSON.stringify({ caller: { workspace_id: "workspace-gui", surface_id: "surface-gui", surface_type: "terminal" } }));
					}
					return okResult();
				},
			},
		);

		await harness.emit("session_start");
		const results = await harness.emit("before_agent_start", { prompt: "Retry", systemPrompt: ["base"] });
		expect(identifyAttempts).toBe(2);
		expect(JSON.stringify(results)).toContain("Workspace: workspace-gui");
		expect(JSON.stringify(results)).toContain("Surface/tab: surface-gui");
		await harness.dispose();
	});

	test("hides stale or unsafe GUI identities when exact preflight fails", async () => {
		const unsafeWorkspace = "/tmp/private.sock\n";
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, PI_MACHINE_NAME: "zacbook", CMUX_WORKSPACE_ID: unsafeWorkspace, CMUX_SURFACE_ID: "surface-stale" },
			{ platform: "darwin", runResult: () => okResult("{}") },
		);

		const results = await harness.emit("before_agent_start", { prompt: "Unsafe", systemPrompt: ["base"] });
		const serialized = JSON.stringify(results);
		expect(serialized).toContain("Workspace: unavailable");
		expect(serialized).toContain("Surface/tab: unavailable");
		expect(serialized).not.toContain("private.sock");
		expect(serialized).not.toContain("surface-stale");
		await harness.dispose();
	});

	test("selects TUI target IDs and route ahead of stale GUI values without exposing the socket", async () => {
		const harness = lifecycleHarness(
			{
				PATH: process.env.PATH,
				CMUX_TUI_SOCKET: "/run/user/1000/cmux/main.sock",
				CMUX_TUI_WORKSPACE_ID: "4",
				CMUX_TUI_SURFACE_ID: "17",
				CMUX_WORKSPACE_ID: "workspace-stale",
				CMUX_SURFACE_ID: "surface-stale",
			},
			{ hostname: () => "davailocal", platform: "linux" },
		);

		const results = await harness.emit("before_agent_start", { prompt: "TUI prompt", systemPrompt: ["base"] });

		expect(results).toEqual([{
			systemPrompt: [
				"base",
				"<runtime-environment>\nMachine: davailocal\nOMP interface: cmux TUI\n</runtime-environment>",
				"<cmux-runtime-target>\nMachine: davailocal\nSystem: linux\nBackend: tui\nWorkspace: 4\nSurface/tab: 17\nSurface type: terminal\nTool route: cmux_cli\n</cmux-runtime-target>",
			],
		}]);
		const serialized = JSON.stringify(results);
		expect(serialized).not.toContain("workspace-stale");
		expect(serialized).not.toContain("surface-stale");
		expect(serialized).not.toContain("/run/user/1000/cmux/main.sock");
		await harness.dispose();
	});

	test("rejects an injected TUI workspace and surface that do not form one owned topology target", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_WORKSPACE_ID: "4", CMUX_TUI_SURFACE_ID: "17" },
			{
				pid: 4_101,
				ppid: 4_100,
				hostname: () => "davailocal",
				platform: "linux",
				runResult(argv) {
					if (argv[0] === "process-info") return okResult(JSON.stringify({ pid: 4_100 }));
					if (argv.includes("list-workspaces")) {
						return okResult(JSON.stringify({ workspaces: [{ id: 5, screens: [{ panes: [{ tabs: [{ surface: 17, kind: "pty" }] }] }] }] }));
					}
					return okResult();
				},
			},
		);

		const results = await harness.emit("before_agent_start", { prompt: "TUI mismatch", systemPrompt: ["base"] });
		const serialized = JSON.stringify(results);
		expect(serialized).toContain("Workspace: unavailable");
		expect(serialized).toContain("Surface/tab: unavailable");
		expect(tuiCalls(harness, "report-agent")).toEqual([]);
		await harness.dispose();
	});

	test("keeps headless interface context fail closed without native target queries", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "8", CMUX_TUI_WORKSPACE_ID: "6" },
			{ hasUI: false, hostname: () => "epyc-omp-workspace", platform: "linux" },
		);
		const results = await harness.emit("before_agent_start", { prompt: "Task", systemPrompt: ["base"] });
		expect(results).toEqual([{
			systemPrompt: [
				"base",
				"<runtime-environment>\nMachine: epyc-omp-workspace\nOMP interface: headless agent under cmux TUI\n</runtime-environment>",
				"<cmux-runtime-target>\nMachine: epyc-omp-workspace\nSystem: linux\nBackend: tui\nWorkspace: unavailable\nSurface/tab: unavailable\nSurface type: unavailable\nTool route: unavailable\n</cmux-runtime-target>",
			],
		}]);
		expect(harness.calls).toEqual([]);
		await harness.dispose();
	});
	test("does not reuse a cached interactive root target in a later headless prompt", async () => {
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, PI_MACHINE_NAME: "zacbook", CMUX_WORKSPACE_ID: "workspace-root", CMUX_SURFACE_ID: "surface-root" },
			{
				platform: "darwin",
				runResult(argv) {
					if (argv.includes("identify")) {
						return okResult(JSON.stringify({ caller: { workspace_id: "workspace-root", surface_id: "surface-root", surface_type: "terminal" } }));
					}
					return okResult();
				},
			},
		);

		const rootResults = await harness.emit("before_agent_start", { prompt: "Root", systemPrompt: ["base"] });
		expect(JSON.stringify(rootResults)).toContain("Workspace: workspace-root");

		const headlessResults = await harness.emit(
			"before_agent_start",
			{ prompt: "Delegated", systemPrompt: ["base"] },
			{ ...harness.context, hasUI: false },
		);
		const serialized = JSON.stringify(headlessResults);
		expect(serialized).toContain("Workspace: unavailable");
		expect(serialized).toContain("Surface/tab: unavailable");
		expect(serialized).not.toContain("workspace-root");
		expect(serialized).not.toContain("surface-root");
		await harness.dispose();
	});

});

describe("semantic notifications", () => {
	test("uses native TUI notify and forwards SSH desktop notifications for semantic outcomes with exact dedupe", async () => {
		const forwarded: ForwardedNotification[] = [];
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, HOSTNAME: "davailocal", CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock", CMUX_TUI_SURFACE_ID: "5", SSH_TTY: "/dev/pts/7" },
			{ forwardSshNotification(notification) { forwarded.push(notification); return 1; } },
		);
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
		for (const argv of notifications) {
			expect(argv).not.toContain("--subtitle");
			expect(option(argv, "--body")).toContain("Session: davailocal · cmux TUI");
		}
		for (const argv of notifications) expect(option(argv, "--surface")).toBe("5");
		expect(forwarded.map(notification => notification.title)).toEqual([
			"OMP needs your input",
			"OMP needs tool approval",
			"OMP plan ready",
			"OMP needs your input",
		]);
		for (const notification of forwarded) {
			expect(notification.body).toContain("Session: davailocal · cmux TUI");
			expect(notification.body).not.toContain("Please choose a deployment.");
		}
		await harness.dispose();
	});

	test("classifies completion, blocked, and error settlements and suppresses aborted or stop-hook-owned turns", async () => {
		const cases = [
			[{ role: "assistant", content: "All done." }, "OMP turn complete", "info"],
			[{ role: "assistant", content: "Cannot comply.", stopReason: "blocked" }, "OMP turn blocked", "warning"],
			[{ role: "assistant", content: "", errorMessage: "provider failed" }, "OMP turn failed", "error"],
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
			expect(option(notification, "--subtitle")).toBeUndefined();
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
		const harness = lifecycleHarness(
			{ PATH: process.env.PATH, HOSTNAME: "zacbook", CMUX_WORKSPACE_ID: "workspace-gui", CMUX_SURFACE_ID: "surface-gui" },
			{
				runResult(argv) {
					if (argv.includes("identify")) {
						return okResult(JSON.stringify({ caller: { workspace_id: "workspace-gui", surface_id: "surface-gui", surface_type: "terminal" } }));
					}
					return okResult();
				},
			},
		);
		await harness.emit("session_start");
		await harness.emit("before_agent_start", { prompt: "GUI prompt" });
		await harness.emit("tool_execution_start", { toolCallId: "ask-gui", toolName: "ask" });
		await flush(harness);
		expect(guiCalls(harness, "set-status").some(call => call.argv.includes("workspace-gui"))).toBe(true);
		const notification = guiCalls(harness, "notify").at(-1)!.argv;
		expect(notification).toContain("workspace-gui");
		expect(notification).toContain("surface-gui");
		expect(option(notification, "--subtitle")).toBe("Waiting · zacbook · GUI");
		expect(tuiCalls(harness, "report-agent")).toEqual([]);
		await harness.dispose();
	});
});
