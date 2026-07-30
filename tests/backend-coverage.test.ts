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
	CMUX_TUI_PROTOCOL_COMMANDS,
} from "../plugins/cmux/src/source-contracts.ts";
import { CmuxBrowserSchema, CmuxWorkspaceSchema } from "../plugins/cmux/src/schemas.ts";
import { registerCmuxTools } from "../plugins/cmux/src/tools.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

type ToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
};

type RunCall = { argv: string[]; options: CmuxRunOptions };

type CommandContract = { source: string; commands: string[]; protocolSource?: string; protocolCommands?: string[] };

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

const EXPECTED_GUI_BINARY = process.platform === "darwin"
	? "/Applications/cmux.app/Contents/Resources/bin/cmux"
	: "cmux-gui-test";

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

function actionNames(tool: ToolDefinition | undefined): string[] {
	const schema = tool?.parameters as { properties?: { action?: { anyOf?: Array<{ const?: unknown }> } } } | undefined;
	return schema?.properties?.action?.anyOf?.flatMap(entry => typeof entry.const === "string" ? [entry.const] : []) ?? [];
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
		expect(resolveCmuxBackendBinary("gui", GUI_ENV)).toBe(EXPECTED_GUI_BINARY);
	});
});

describe("source-derived total command coverage", () => {
	test("publishes exact, unique GUI and TUI inventories derived from upstream source", () => {
		const gui = contract("cmux-gui-commands.json");
		const tui = contract("cmux-tui-commands.json");
		expect(gui.source).toMatch(/^https:\/\/github\.com\/manaflow-ai\/cmux\/blob\/main\//);
		expect(tui.source).toMatch(/^https:\/\/github\.com\/manaflow-ai\/cmux\/blob\/main\//);
		expect(tui.protocolSource).toMatch(/^https:\/\/github\.com\/manaflow-ai\/cmux\/blob\/main\//);
		expect(gui.commands).toHaveLength(163);
		expect(tui.commands).toHaveLength(62);
		expect(tui.protocolCommands).toHaveLength(87);
		expect(new Set(gui.commands).size).toBe(gui.commands.length);
		expect(new Set(tui.commands).size).toBe(tui.commands.length);
		expect(new Set(tui.protocolCommands ?? []).size).toBe(tui.protocolCommands?.length ?? 0);
		expect(gui.commands).toEqual([...CMUX_GUI_COMMANDS]);
		expect(tui.commands).toEqual([...CMUX_TUI_COMMANDS]);
		expect(tui.protocolCommands).toEqual([...CMUX_TUI_PROTOCOL_COMMANDS]);
	});

	test("keeps every documented GUI browser action in the schema and executable mapping", async () => {
		const schema = CmuxBrowserSchema as unknown as { properties: { action: { anyOf: Array<{ const: string }> } } };
		const actions = schema.properties.action.anyOf.map(entry => entry.const);
		expect(actions).toEqual([...CMUX_GUI_BROWSER_ACTIONS]);
		expect(actions).toHaveLength(63);
		const harness = toolHarness(GUI_ENV);
		for (const action of actions) {
			const result = await execute(harness, "cmux_browser", { action, arguments: ["contract-argument"] });
			expect(result.isError, action).toBe(false);
		}
		expect(harness.calls).toHaveLength(actions.length);
		expect(harness.calls.every(call => call.options.binary === EXPECTED_GUI_BINARY)).toBe(true);
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
			expect(harness.calls.map(call => call.argv[0])).toEqual([...commands]);
			expect(harness.calls.every(call => call.options.binary === (backend === "tui" ? "cmux-tui-test" : EXPECTED_GUI_BINARY))).toBe(true);
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
				sourceContract: { commands: [...CMUX_TUI_COMMANDS], protocolCommands: [...CMUX_TUI_PROTOCOL_COMMANDS] },
			},
		});
		expect(result.content[0]?.text).toMatch(/backend:\s*tui/iu);
		expect(result.content[0]?.text).toMatch(/CLI commands[^]*list-workspaces[^]*new-browser-tab/iu);
		expect(result.content[0]?.text).toMatch(/protocol commands/iu);
		expect(result.content[0]?.text).toContain("create-workspace");
		expect(result.content[0]?.text).toContain("browser-navigate");
	});

	test("documents the exact numeric TUI workspace target in the callable schema", () => {
		const schema = CmuxWorkspaceSchema as unknown as {
			properties: { workspace_id: { description?: string } };
		};
		const workspaceId = schema.properties.workspace_id.description;
		expect(workspaceId).toMatch(/TUI[^.]*numeric[^.]*(?:workspace_id|CMUX_TUI_WORKSPACE_ID)/u);
		expect(workspaceId).toMatch(/never[^.]*focused/iu);
	});

	test("registers no unsupported tools when no backend route is active", () => {
		const harness = toolHarness({ PATH: "/tools" });
		expect([...harness.tools.keys()]).toEqual([]);
		expect(harness.calls).toEqual([]);
	});

	test("registers only tools and actions supported by the active backend", async () => {
		const gui = toolHarness(GUI_ENV);
		expect([...gui.tools.keys()]).toEqual([
			"cmux_capabilities",
			"cmux_rpc",
			"cmux_cli",
			"cmux_workspace",
			"cmux_surface",
			"cmux_browser",
			"cmux_notification",
			"cmux_sidebar",
		]);
		expect(gui.tools.get("cmux_cli")?.description).toContain("cmux GUI");
		await execute(gui, "cmux_capabilities", {});
		await execute(gui, "cmux_rpc", { method: "workspace.list", params: {} });
		expect(gui.calls.map(call => call.argv)).toEqual([
			["capabilities"],
			["rpc", "workspace.list", "{}"],
		]);

		const tui = toolHarness(TUI_ENV);
		expect([...tui.tools.keys()]).toEqual([
			"cmux_capabilities",
			"cmux_cli",
			"cmux_workspace",
			"cmux_surface",
			"cmux_browser",
			"cmux_notification",
		]);
		expect(tui.tools.has("cmux_rpc")).toBe(false);
		expect(tui.tools.has("cmux_sidebar")).toBe(false);
		expect(tui.tools.get("cmux_cli")?.description).toContain("cmux TUI");
		expect(actionNames(tui.tools.get("cmux_workspace"))).toEqual(["list", "create", "close", "rename"]);
		expect(actionNames(tui.tools.get("cmux_surface"))).toEqual(["list", "create", "split", "close", "identify", "read", "send_text", "send_key"]);
		expect(actionNames(tui.tools.get("cmux_browser"))).toEqual(["open", "new"]);
		expect(actionNames(tui.tools.get("cmux_notification"))).toEqual(["send"]);
	});

	test("translates exact workspace, surface, browser creation, and notification actions", async () => {
		const harness = toolHarness(TUI_ENV);
		await execute(harness, "cmux_workspace", { action: "list" });
		await execute(harness, "cmux_workspace", { action: "rename", workspace_id: "4", title: "Build" });
		await execute(harness, "cmux_surface", { action: "read", scrollback: true, lines: 12 });
		await execute(harness, "cmux_surface", { action: "send_key", key: "CTRL+C" });
		await execute(harness, "cmux_browser", { action: "open", arguments: ["--url", "https://example.test", "--pane", "3"] });
		await execute(harness, "cmux_notification", { action: "send", title: "Done", body: "Ready", level: "warning" });
		expect(harness.calls.map(call => call.argv)).toEqual([
			["--json", "list-workspaces"],
			["--json", "rename-workspace", "--workspace", "4", "--name", "Build"],
			["--json", "read-scrollback", "--surface", "17", "--start", "0", "--count", "12"],
			["--json", "send-key", "--surface", "17", "ctrl+c"],
			["--json", "new-browser-tab", "--url", "https://example.test", "--pane", "3"],
			["--json", "notify", "--title", "Done", "--body", "Ready", "--level", "warning", "--surface", "17"],
		]);
	});

	test("omits GUI-only DOM and sidebar actions from TUI tool schemas", () => {
		const harness = toolHarness(TUI_ENV);
		expect(actionNames(harness.tools.get("cmux_browser"))).not.toContain("snapshot");
		expect(harness.tools.has("cmux_sidebar")).toBe(false);
		expect(harness.calls).toEqual([]);
	});
});

describe("cluster update CI", () => {
	test("runs locked and latest OMP compatibility in untrusted Kubernetes on push, PR, manual, and cron", () => {
		const pipeline = readFileSync(resolve(import.meta.dir, "../.woodpecker.yml"), "utf8");
		const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { devDependencies: Record<string, string> };
		expect(packageJson.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("17.1.8");
		for (const event of ["push", "pull_request", "manual", "cron"]) expect(pipeline).toContain(`- ${event}`);
		expect(pipeline).toContain('if [ "$CI_PIPELINE_EVENT" = "cron" ]; then git fetch --force --tags https://github.com/usr-bin-roygbiv/omp-cmux.git main && git checkout --detach FETCH_HEAD; fi');
		expect(pipeline).toContain("locked-omp-contract:");
		expect(pipeline).toContain("latest-omp-contract:");
		expect(pipeline).toContain("bun add --dev --no-save @oh-my-pi/pi-coding-agent@latest");
		expect(pipeline).toContain("serviceAccountName: woodpecker-ci-untrusted");
		expect(pipeline.match(/ephemeral-storage: 512Mi/g) ?? []).toHaveLength(2);
		expect(pipeline.match(/ephemeral-storage: 4Gi/g) ?? []).toHaveLength(2);
		expect(pipeline.match(/harbor\.tailb18de3\.ts\.net\/linkedin-bot\/epyc-omp-workspace@sha256:2afa16d957719844939b2a45bad687e1e3cecf22abe23682e59972a076984e3f/g) ?? []).toHaveLength(2);
		expect(pipeline.match(/HOME: \/tmp/g) ?? []).toHaveLength(2);
		expect(pipeline).not.toMatch(/docker\.io|hostPath|privileged:\s*true/i);
	});
});
