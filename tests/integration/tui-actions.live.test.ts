import { expect, test } from "bun:test";

import { registerCmuxTools } from "../../plugins/cmux/src/tools.ts";

const liveTest = process.env.CMUX_TUI_ACTIONS_INTEGRATION === "1" ? test : test.skip;

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: { json?: unknown };
	isError?: boolean;
};

type Tool = { execute: (...args: unknown[]) => Promise<unknown> };
type WorkspaceTree = {
	workspaces: Array<{
		active: boolean;
		id: number;
		name: string | null;
		screens: Array<{ panes: Array<{ id: number; tabs: Array<{ surface: number; kind: string }> }> }>;
	}>;
};

liveTest(
	"exercises typed TUI mutations only inside an owned workspace",
	async () => {
		const tools = new Map<string, Tool>();
		registerCmuxTools({
			registerTool(tool: Tool & { name: string }) {
				tools.set(tool.name, tool);
			},
		} as never);

		const execute = async (name: string, params: Record<string, unknown>): Promise<ToolResult> => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`missing tool ${name}`);
			return await tool.execute(`live-${name}`, params, new AbortController().signal) as ToolResult;
		};
		const json = <T>(result: ToolResult): T => {
			expect(result.isError, result.content[0]?.text).toBe(false);
			return result.details.json as T;
		};
		const list = async (): Promise<WorkspaceTree> => json<WorkspaceTree>(await execute("cmux_workspace", { action: "list" }));

		const initial = await list();
		const originalIndex = initial.workspaces.findIndex(workspace => workspace.active);
		expect(originalIndex).toBeGreaterThanOrEqual(0);
		const name = `omp-cmux-live-${process.pid}`;
		let workspaceId: number | undefined;

		try {
			json(await execute("cmux_workspace", { action: "create", name }));
			const createdTree = await list();
			const workspace = createdTree.workspaces.find(candidate => candidate.name === name);
			expect(workspace).toBeDefined();
			workspaceId = workspace!.id;
			const pane = workspace!.screens[0]?.panes[0];
			const terminal = pane?.tabs[0];
			expect(pane).toBeDefined();
			expect(terminal?.kind).toBe("pty");

			json(await execute("cmux_workspace", { action: "rename", workspace_id: String(workspaceId), title: `${name}-renamed` }));
			json(await execute("cmux_surface", { action: "send_text", surface_id: String(terminal!.surface), text: "printf 'omp-cmux-live-ok\\n'\\n" }));
			const screen = await execute("cmux_surface", { action: "read", surface_id: String(terminal!.surface) });
			expect(screen.isError, screen.content[0]?.text).toBe(false);
			expect(screen.content[0]?.text).toContain("omp-cmux-live-ok");
			json(await execute("cmux_surface", { action: "send_key", surface_id: String(terminal!.surface), key: "ENTER" }));
			json(await execute("cmux_notification", { action: "send", surface_id: String(terminal!.surface), title: "OMP cmux smoke", body: "Owned TUI workspace", level: "info" }));

			const browser = json<{ surface: number }>(await execute("cmux_browser", {
				action: "open",
				arguments: ["--url", "about:blank", "--pane", String(pane!.id)],
			}));
			expect(browser.surface).toBeNumber();
			json(await execute("cmux_surface", { action: "close", surface_id: String(browser.surface) }));

			const tab = json<{ surface: number }>(await execute("cmux_surface", {
				action: "create",
				pane_id: String(pane!.id),
				cwd: process.cwd(),
			}));
			expect(tab.surface).toBeNumber();
			json(await execute("cmux_surface", { action: "close", surface_id: String(tab.surface) }));
		} finally {
			const tree = await list();
			const owned = tree.workspaces.find(workspace => workspace.id === workspaceId || workspace.name?.startsWith(name));
			if (owned) await execute("cmux_workspace", { action: "close", workspace_id: String(owned.id) });
			await execute("cmux_cli", { argv: ["--json", "select-workspace", "--index", String(originalIndex)] });
		}

		const finalTree = await list();
		expect(finalTree.workspaces.some(workspace => workspace.name?.startsWith(name))).toBe(false);
	},
	60_000,
);
