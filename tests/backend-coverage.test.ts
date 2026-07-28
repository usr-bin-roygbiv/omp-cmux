import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	detectCmuxBackend,
	resolveCmuxBackendBinary,
	type CmuxBackend,
	type CmuxCommandResult,
	type CmuxRunOptions,
} from "../plugins/cmux/src/cmux.ts";
import {
	CMUX_GUI_BROWSER_ACTIONS,
	CMUX_GUI_COMMANDS,
	CMUX_TUI_COMMANDS,
} from "../plugins/cmux/src/source-contracts.ts";
import { CmuxBrowserSchema } from "../plugins/cmux/src/schemas.ts";
import { registerCmuxTools } from "../plugins/cmux/src/tools.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

type ToolDefinition = {
	name: string;
	description: string;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
};

type RunCall = { argv: string[]; options: CmuxRunOptions };

type CommandContract = { source: string; commands: string[] };

const GUI_ENV: NodeJS.ProcessEnv = {
	PATH: "/tools",
	CMUX_WORKSPACE_ID: "workspace-gui",
	CMUX_SURFACE_ID: "surface-gui",
	CMUX_OMP_BINARY: "cmux-gui-test",
};

const TUI_ENV: NodeJS.ProcessEnv = {
	PATH: "/tools",
	CMUX_TUI_SOCKET: "/runtime/cmux.sock",
	CMUX_TUI_SURFACE_ID: "17",
	CMUX_TUI_WORKSPACE_ID: "4",
	CMUX_OMP_TUI_BINARY: "cmux-tui-test",
	CMUX_WORKSPACE_ID: "workspace-must-not-win",
	CMUX_SURFACE_ID: "surface-must-not-win",
	CMUX_OMP_BINARY: "cmux-gui-must-not-win",
};

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

function toolHarness(env: NodeJS.ProcessEnv, result: CmuxCommandResult = commandResult()) {
	const tools = new Map<string, ToolDefinition>();
	const calls: RunCall[] = [];
	const run = async (argv: readonly string[], options: CmuxRunOptions = {}) => {
		calls.push({ argv: [...argv], options });
		return result;
	};
	registerCmuxTools({
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
	} as never, { run, env });
	return { tools, calls };
}

async function execute(
	harness: ReturnType<typeof toolHarness>,
	name: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool.execute("call-1", params, signal);
}

function contract(name: string): CommandContract {
	return JSON.parse(readFileSync(resolve(import.meta.dir, `contracts/${name}`), "utf8")) as CommandContract;
}

describe("backend detection and binary routing", () => {
	test("selects TUI before GUI, requires a complete GUI route, and fails closed outside cmux", () => {
		expect(detectCmuxBackend(TUI_ENV)).toBe("tui");
		expect(detectCmuxBackend(GUI_ENV)).toBe("gui");
		expect(() => detectCmuxBackend({ CMUX_WORKSPACE_ID: "workspace-only" })).toThrow(/incomplete cmux GUI route/i);
		expect(() => detectCmuxBackend({})).toThrow(/no cmux GUI or TUI route/i);
	});

	test("resolves only the binary for the detected backend", () => {
		expect(resolveCmuxBackendBinary("tui", TUI_ENV)).toBe("cmux-tui-test");
		expect(resolveCmuxBackendBinary("gui", GUI_ENV)).toBe("cmux-gui-test");
	});
});

describe("source-derived total command coverage", () => {
	test("publishes exact, unique GUI and TUI inventories derived from upstream source", () => {
		const gui = contract("cmux-gui-commands.json");
		const tui = contract("cmux-tui-commands.json");
		expect(gui.source).toMatch(/^https:\/\/github\.com\/manaflow-ai\/cmux\/blob\/main\//);
		expect(tui.source).toMatch(/^https:\/\/github\.com\/manaflow-ai\/cmux\/blob\/main\//);
		expect(gui.commands).toHaveLength(163);
		expect(tui.commands).toHaveLength(58);
		expect(new Set(gui.commands).size).toBe(gui.commands.length);
		expect(new Set(tui.commands).size).toBe(tui.commands.length);
		expect(CMUX_GUI_COMMANDS).toEqual(gui.commands);
		expect(CMUX_TUI_COMMANDS).toEqual(tui.commands);
	});

	test("keeps every documented GUI browser action in the schema and executable mapping", async () => {
		const actions = (CmuxBrowserSchema.properties.action.anyOf as Array<{ const: string }>).map(entry => entry.const);
		expect(actions).toEqual(CMUX_GUI_BROWSER_ACTIONS);
		expect(actions).toHaveLength(61);
		const harness = toolHarness(GUI_ENV);
		for (const action of actions) {
			const result = await execute(harness, "cmux_browser", { action, arguments: ["contract-argument"] });
			expect(result.isError, action).toBe(false);
		}
		expect(harness.calls).toHaveLength(actions.length);
		expect(harness.calls.every(call => call.options.binary === "cmux-gui-test")).toBe(true);
	});

	test("routes every source-listed command through the backend-specific raw CLI escape hatch", async () => {
		for (const [backend, env, commands] of [
			["gui", GUI_ENV, CMUX_GUI_COMMANDS],
			["tui", TUI_ENV, CMUX_TUI_COMMANDS],
		] as const satisfies ReadonlyArray<readonly [CmuxBackend, NodeJS.ProcessEnv, readonly string[]]>) {
			const harness = toolHarness(env);
			for (const command of commands) {
				const result = await execute(harness, "cmux_cli", { argv: [command, "--help"] });
				expect(result.isError, `${backend}:${command}`).toBe(false);
			}
			expect(harness.calls.map(call => call.argv[0])).toEqual(commands);
			expect(harness.calls.every(call => call.options.binary === (backend === "tui" ? "cmux-tui-test" : "cmux-gui-test"))).toBe(true);
		}
	});
});

describe("TUI-aware typed tools", () => {
	test("discovers TUI identity instead of invoking the GUI-only capabilities verb", async () => {
		const harness = toolHarness(TUI_ENV, commandResult({ stdout: '{"protocol":10,"session":"test"}' }));
		const result = await execute(harness, "cmux_capabilities", {});
		expect(harness.calls).toEqual([{
			argv: ["--json", "identify"],
			options: { binary: "cmux-tui-test", env: TUI_ENV },
		}]);
		expect(result).toMatchObject({
			isError: false,
			details: {
				backend: "tui",
				json: { protocol: 10, session: "test" },
				sourceContract: { commands: CMUX_TUI_COMMANDS },
			},
		});
	});

	test("keeps GUI capabilities and RPC native while rejecting TUI RPC before execution", async () => {
		const gui = toolHarness(GUI_ENV);
		await execute(gui, "cmux_capabilities", {});
		await execute(gui, "cmux_rpc", { method: "workspace.list", params: {} });
		expect(gui.calls.map(call => call.argv)).toEqual([
			["capabilities"],
			["rpc", "workspace.list", "{}"],
		]);
		expect(gui.calls.every(call => call.options.binary === "cmux-gui-test")).toBe(true);

		const tui = toolHarness(TUI_ENV);
		const rejected = await execute(tui, "cmux_rpc", { method: "workspace.list" });
		expect(tui.calls).toEqual([]);
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0]?.text).toMatch(/RPC is available only in cmux GUI; use cmux_cli for TUI/i);
	});

	test("translates exact workspace, surface, browser creation, and notification actions", async () => {
		const harness = toolHarness(TUI_ENV);
		await execute(harness, "cmux_workspace", { action: "list" });
		await execute(harness, "cmux_workspace", { action: "rename", workspace_id: "4", title: "Build" });
		await execute(harness, "cmux_surface", { action: "read", scrollback: true, lines: 12 });
		await execute(harness, "cmux_surface", { action: "send_key", key: "CTRL+C" });
		await execute(harness, "cmux_browser", { action: "open", arguments: ["--url", "https://example.test", "--pane", "3"] });
		await execute(harness, "cmux_notification", { action: "send", title: "Done", body: "Ready" });
		expect(harness.calls.map(call => call.argv)).toEqual([
			["--json", "list-workspaces"],
			["--json", "rename-workspace", "--workspace", "4", "--name", "Build"],
			["--json", "read-scrollback", "--surface", "17", "--start", "0", "--count", "12"],
			["--json", "send-key", "--surface", "17", "ctrl+c"],
			["--json", "new-browser-tab", "--url", "https://example.test", "--pane", "3"],
			["--json", "notify", "--title", "Done", "--body", "Ready", "--surface", "17"],
		]);
	});

	test("rejects GUI-only DOM automation and sidebar actions with precise backend errors", async () => {
		const harness = toolHarness(TUI_ENV);
		const browser = await execute(harness, "cmux_browser", { action: "snapshot" });
		const sidebar = await execute(harness, "cmux_sidebar", { action: "state" });
		expect(harness.calls).toEqual([]);
		expect(browser.content[0]?.text).toMatch(/snapshot is not supported by cmux TUI/i);
		expect(sidebar.content[0]?.text).toMatch(/sidebar state is not supported by cmux TUI/i);
	});
});

describe("cluster update CI", () => {
	test("runs locked and latest OMP compatibility in untrusted Kubernetes on push, PR, manual, and cron", () => {
		const pipeline = readFileSync(resolve(import.meta.dir, "../.woodpecker.yml"), "utf8");
		for (const event of ["push", "pull_request", "manual", "cron"]) expect(pipeline).toContain(`- ${event}`);
		expect(pipeline).toContain("locked-omp-contract:");
		expect(pipeline).toContain("latest-omp-contract:");
		expect(pipeline).toContain("@oh-my-pi/pi-coding-agent@latest");
		expect(pipeline).toContain("serviceAccountName: woodpecker-ci-untrusted");
		expect(pipeline).toContain("mirror.gcr.io/oven/bun:");
		expect(pipeline).not.toMatch(/docker\.io|hostPath|privileged:\s*true/i);
	});
});
