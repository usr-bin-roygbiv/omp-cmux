import { describe, expect, test } from "bun:test";

import { registerCmuxTools } from "../plugins/cmux/src/tools.ts";
import type { CmuxCommandResult, CmuxRunOptions } from "../plugins/cmux/src/cmux.ts";
import {
	CmuxBrowserSchema,
	CmuxCapabilitiesSchema,
	CmuxCliSchema,
	CmuxNotificationSchema,
	CmuxRpcSchema,
	CmuxSidebarSchema,
	CmuxSurfaceSchema,
	CmuxWorkspaceSchema,
} from "../plugins/cmux/src/schemas.ts";

type ToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
};

type RunCall = { argv: string[]; options: CmuxRunOptions };

function commandResult(overrides: Partial<CmuxCommandResult> = {}): CmuxCommandResult {
	return {
		ok: true,
		exitCode: 0,
		signal: null,
		stdout: '{"ok":true}',
		stderr: "",
		timedOut: false,
		aborted: false,
		truncated: { stdout: false, stderr: false },
		...overrides,
	};
}

function toolHarness(result: CmuxCommandResult | CmuxCommandResult[] = commandResult()) {
	const tools = new Map<string, ToolDefinition>();
	const calls: RunCall[] = [];
	let resultIndex = 0;
	const api = {
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
	};
	const run = async (argv: readonly string[], options: CmuxRunOptions = {}) => {
		calls.push({ argv: [...argv], options });
		if (!Array.isArray(result)) return result;
		const selected = result[Math.min(resultIndex, result.length - 1)];
		resultIndex += 1;
		if (!selected) throw new Error("tool harness requires at least one command result");
		return selected;
	};
	registerCmuxTools(api as never, { run });
	return { tools, calls };
}

async function execute(harness: ReturnType<typeof toolHarness>, name: string, params: Record<string, unknown>, signal?: AbortSignal) {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool.execute("call-1", params, signal);
}

describe("dependency-free tool schemas", () => {
	test("emit valid JSON Schema required fields without runtime packages", () => {
		const schemas = [
			[CmuxCapabilitiesSchema, []],
			[CmuxRpcSchema, ["method"]],
			[CmuxCliSchema, ["argv"]],
			[CmuxWorkspaceSchema, ["action"]],
			[CmuxSurfaceSchema, ["action"]],
			[CmuxBrowserSchema, ["action"]],
			[CmuxNotificationSchema, ["action"]],
			[CmuxSidebarSchema, ["action"]],
		] as const;

		for (const [schema, required] of schemas) {
			const plain = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
			expect(plain.type).toBe("object");
			expect(plain.additionalProperties).toBe(false);
			expect(plain.required ?? []).toEqual(required);
		}
	});
});

describe("cmux coverage escape hatches", () => {
	test("registers the three complete escape hatches and every high-value typed group", () => {
		const { tools } = toolHarness();
		expect([...tools.keys()]).toEqual([
			"cmux_capabilities",
			"cmux_rpc",
			"cmux_cli",
			"cmux_workspace",
			"cmux_surface",
			"cmux_browser",
			"cmux_notification",
			"cmux_sidebar",
		]);
	});

	test("discovers advertised capabilities and returns parsed JSON in details", async () => {
		const harness = toolHarness(commandResult({ stdout: '{"rpcMethods":["workspace.list"],"features":["browser"]}' }));
		const signal = new AbortController().signal;
		const result = await execute(harness, "cmux_capabilities", { timeout_ms: 4321 }, signal);

		expect(harness.calls).toEqual([{ argv: ["capabilities"], options: { timeoutMs: 4321, signal } }]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: '{"rpcMethods":["workspace.list"],"features":["browser"]}' }],
			details: {
				operation: "capabilities",
				json: { rpcMethods: ["workspace.list"], features: ["browser"] },
				result: { ok: true },
			},
			isError: false,
		});
	});

	test("marks malformed capability output as an error instead of advertising unusable discovery", async () => {
		const harness = toolHarness(commandResult({ stdout: "not-json" }));
		const result = await execute(harness, "cmux_capabilities", {});
		expect(result).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "cmux returned invalid JSON output" }],
			details: { operation: "capabilities", jsonError: "cmux returned invalid JSON output" },
		});
	});

	test("translates arbitrary RPC method and params into isolated argv and propagates abort", async () => {
		const harness = toolHarness(commandResult({ stdout: '{"result":"ok"}' }));
		const controller = new AbortController();
		const params = { title: "quoted; $(not-a-command)", nested: { enabled: true } };
		const result = await execute(
			harness,
			"cmux_rpc",
			{ method: "future.method", params, timeout_ms: 9000 },
			controller.signal,
		);

		expect(harness.calls).toEqual([
			{
				argv: ["rpc", "future.method", JSON.stringify(params)],
				options: { timeoutMs: 9000, signal: controller.signal },
			},
		]);
		expect(result).toMatchObject({ isError: false, details: { operation: "rpc:future.method", json: { result: "ok" } } });
	});

	test("passes arbitrary CLI argv and stdin unchanged without parsing a command string", async () => {
		const harness = toolHarness(commandResult({ stdout: "plain output" }));
		const argv = ["future-command", "--name", "two words; still one arg"];
		const result = await execute(harness, "cmux_cli", { argv, stdin: "payload\n", timeout_ms: 50 });

		expect(harness.calls).toEqual([{ argv, options: { timeoutMs: 50, stdin: "payload\n" } }]);
		expect(result).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "plain output" }],
			details: { operation: "cli" },
		});
	});

	test("preserves command failures, truncation notice, and structured execution details", async () => {
		const harness = toolHarness(
			commandResult({
				ok: false,
				exitCode: 7,
				stdout: "",
				stderr: "permission denied",
				truncated: { stdout: false, stderr: true },
				error: { code: "EXIT_ERROR", message: "cmux exited with code 7" },
			}),
		);
		const result = await execute(harness, "cmux_cli", { argv: ["status"] });
		expect(result).toMatchObject({ isError: true, details: { operation: "cli", result: { exitCode: 7 } } });
		expect(result.content[0]!.text).toContain("permission denied");
		expect(result.content[0]!.text).toContain("output truncated");
	});

	test("documents native GUI syntax and supported browser recovery paths", () => {
		const { tools } = toolHarness();
		const cliDescription = tools.get("cmux_cli")?.description ?? "";
		const browserDescription = tools.get("cmux_browser")?.description ?? "";
		const surfaceSchema = JSON.stringify(CmuxSurfaceSchema);

		expect(cliDescription).toContain("read-screen");
		expect(cliDescription).toContain("close-surface");
		expect(cliDescription).toContain("positional");
		expect(cliDescription).toContain("file://");
		expect(browserDescription).toContain("snapshot");
		expect(browserDescription).toContain(":has-text");
		expect(browserDescription).toContain("network");
		expect(browserDescription).toContain("input_mouse");
		expect(surfaceSchema).toContain("CTRL_B");
		expect(surfaceSchema).toContain("C-b");
	});
});

describe("typed cmux argv translation", () => {
	test("workspace mutations always include the exact workspace identity", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_workspace", {
			action: "rename",
			workspace_id: "workspace-7",
			window_id: "window-2",
			title: "Build; not a command",
		});
		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"workspace",
			"rename",
			"--window",
			"window-2",
			"--workspace",
			"workspace-7",
			"--title",
			"Build; not a command",
		]);
	});

	test("surface split includes both exact identities and explicit boolean options", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_surface", {
			action: "split",
			workspace_id: "workspace-1",
			surface_id: "surface-4",
			direction: "right",
			focus: false,
		});
		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"new-split",
			"right",
			"--workspace",
			"workspace-1",
			"--surface",
			"surface-4",
			"--focus",
			"false",
		]);
	});

	test("surface text and resume commands use an argv delimiter for user-controlled values", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_surface", {
			action: "send_text",
			workspace_id: "workspace-1",
			surface_id: "surface-1",
			text: "--help; not a command",
		});
		await execute(harness, "cmux_surface", {
			action: "resume_set",
			workspace_id: "workspace-1",
			surface_id: "surface-1",
			resume_name: "worker",
			command_argv: ["program", "argument with spaces", "$(still-not-run)"],
		});
		expect(harness.calls[0]?.argv.slice(-2)).toEqual(["--", "--help; not a command"]);
		expect(harness.calls[1]?.argv.slice(-4)).toEqual(["--", "program", "argument with spaces", "$(still-not-run)"]);
	});

	test("normalizes audited terminal key aliases to native positional key names", async () => {
		const harness = toolHarness();
		for (const [key, expected] of [
			["CTRL_B", "ctrl+b"],
			["C-b", "ctrl+b"],
			["CTRL_C", "ctrl+c"],
			["ESC", "escape"],
			["ENTER", "enter"],
			["LEFT", "left"],
		] as const) {
			await execute(harness, "cmux_surface", {
				action: "send_key",
				workspace_id: "workspace-1",
				surface_id: "surface-1",
				key,
			});
			expect(harness.calls.at(-1)?.argv.slice(-2)).toEqual(["--", expected]);
		}
	});

	test("retries only the exact transient terminal-read startup failure", async () => {
		const transient = commandResult({
			ok: false,
			exitCode: 1,
			stderr: "Error: internal_error: Failed to read terminal text",
			error: { code: "EXIT_ERROR", message: "cmux exited with code 1" },
		});
		const success = commandResult({ stdout: "terminal ready" });
		const harness = toolHarness([transient, success]);
		const result = await execute(harness, "cmux_surface", {
			action: "read",
			workspace_id: "workspace-1",
			surface_id: "surface-1",
		});

		expect(harness.calls).toHaveLength(2);
		expect(result).toMatchObject({ isError: false, content: [{ text: "terminal ready" }] });
	});

	test("keeps the bounded retry window open through four transient startup failures", async () => {
		const transient = commandResult({
			ok: false,
			exitCode: 1,
			stderr: "Error: internal_error: Failed to read terminal text",
			error: { code: "EXIT_ERROR", message: "cmux exited with code 1" },
		});
		const success = commandResult({ stdout: "terminal eventually ready" });
		const harness = toolHarness([transient, transient, transient, transient, success]);
		const result = await execute(harness, "cmux_surface", {
			action: "read",
			workspace_id: "workspace-1",
			surface_id: "surface-1",
		});

		expect(harness.calls).toHaveLength(5);
		expect(result).toMatchObject({ isError: false, content: [{ text: "terminal eventually ready" }] });
	});

	test("does not retry unrelated terminal-read failures", async () => {
		const denied = commandResult({
			ok: false,
			exitCode: 1,
			stderr: "Error: permission denied",
			error: { code: "EXIT_ERROR", message: "cmux exited with code 1" },
		});
		const harness = toolHarness([denied, commandResult({ stdout: "must not run" })]);
		const result = await execute(harness, "cmux_surface", {
			action: "read",
			workspace_id: "workspace-1",
			surface_id: "surface-1",
		});

		expect(harness.calls).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	test("reports the requested closed target instead of cmux's newly selected neighbor", async () => {
		const harness = toolHarness(commandResult({ stdout: "OK surface:neighbor workspace:6" }));
		const result = await execute(harness, "cmux_surface", {
			action: "close",
			workspace_id: "workspace-6",
			surface_id: "surface-requested",
		});

		expect(result).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "Closed surface surface-requested in workspace workspace-6." }],
			details: { target: { workspaceId: "workspace-6", surfaceId: "surface-requested" } },
		});
		expect(result.details.result).toMatchObject({ stdout: "OK surface:neighbor workspace:6" });
	});

	test("browser surface automation retains nested argv and appends exact routing", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_browser", {
			action: "fill",
			arguments: ["#search", "two words"],
			workspace_id: "workspace-browser",
			surface_id: "surface-browser",
		});
		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"browser",
			"--surface",
			"surface-browser",
			"fill",
			"#search",
			"two words",
		]);
	});

	test("routes targeted browser actions with the native leading surface flag and no unsupported workspace flag", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_browser", {
			action: "navigate",
			arguments: ["data:text/html,<button>ready</button>"],
			workspace_id: "workspace-browser",
			surface_id: "surface-browser",
		});

		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"browser",
			"--surface",
			"surface-browser",
			"navigate",
			"data:text/html,<button>ready</button>",
		]);
	});

	test("notifications target the requested surface rather than focused state", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_notification", {
			action: "send",
			workspace_id: "workspace-notify",
			surface_id: "surface-notify",
			title: "Decision needed",
			body: "Choose one",
		});
		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"notify",
			"--workspace",
			"workspace-notify",
			"--surface",
			"surface-notify",
			"--title",
			"Decision needed",
			"--body",
			"Choose one",
		]);
	});

	test("sidebar progress and logs are routed exactly and preserve numeric zero", async () => {
		const harness = toolHarness();
		await execute(harness, "cmux_sidebar", {
			action: "set_progress",
			workspace_id: "workspace-sidebar",
			progress: 0,
			label: "Starting",
		});
		await execute(harness, "cmux_sidebar", {
			action: "log",
			workspace_id: "workspace-sidebar",
			level: "info",
			message: "argv only; no shell",
		});
		expect(harness.calls[0]?.argv).toEqual([
			"--json",
			"set-progress",
			"0",
			"--workspace",
			"workspace-sidebar",
			"--label",
			"Starting",
		]);
		expect(harness.calls[1]?.argv).toEqual([
			"--json",
			"log",
			"--workspace",
			"workspace-sidebar",
			"--level",
			"info",
			"--",
			"argv only; no shell",
		]);
	});

	test("fails closed before execution when a targeted typed action has no exact identity", async () => {
		const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
		const previousSurface = process.env.CMUX_SURFACE_ID;
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.CMUX_SURFACE_ID;
		try {
			const harness = toolHarness();
			const result = await execute(harness, "cmux_surface", { action: "close" });
			expect(harness.calls).toEqual([]);
			expect(result).toMatchObject({ isError: true, details: { operation: "validation" } });
			expect(result.content[0]!.text).toMatch(/workspace identity is required/i);
		} finally {
			if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
			else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
			if (previousSurface === undefined) delete process.env.CMUX_SURFACE_ID;
			else process.env.CMUX_SURFACE_ID = previousSurface;
		}
	});
});
