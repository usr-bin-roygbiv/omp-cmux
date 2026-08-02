import { expect, test } from "bun:test";

import { registerCmuxTools } from "../../plugins/cmux/src/tools.ts";

const workspaceId = process.env.CMUX_WORKSPACE_ID;
const surfaceId = process.env.CMUX_SURFACE_ID;
const liveTest = process.env.CMUX_GUI_ACTIONS_INTEGRATION === "1" && workspaceId && surfaceId ? test : test.skip;

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: { json?: unknown };
	isError?: boolean;
};
type Tool = { execute: (toolCallId: string, params: unknown, signal: AbortSignal) => Promise<ToolResult> };

liveTest(
	"exercises every GUI tool against one exact owned workspace",
	async () => {
		const tools = new Map<string, Tool>();
		registerCmuxTools({
			registerTool(tool: Tool & { name: string }) {
				tools.set(tool.name, tool);
			},
		} as never);
		const signal = new AbortController().signal;
		const invoke = async (name: string, params: unknown): Promise<ToolResult> => {
			const tool = tools.get(name);
			expect(tool, name).toBeDefined();
			return await tool!.execute(`gui-${name}`, params, signal);
		};
		const execute = async (name: string, params: unknown): Promise<ToolResult> => {
			const result = await invoke(name, params);
			expect(result.isError, result.content[0]?.text).toBe(false);
			return result;
		};
		const json = <T>(result: ToolResult): T => {
			expect(result.details.json).toBeDefined();
			return result.details.json as T;
		};
		const statusKey = `omp_cmux_gui_probe_${process.pid}`;
		let browserSurface: string | undefined;

		try {
			json(await execute("cmux_capabilities", {}));
			json(await execute("cmux_rpc", { method: "workspace.list", params: {} }));
			json(await execute("cmux_cli", { argv: ["--json", "list-workspaces"] }));
			json(await execute("cmux_workspace", { action: "list" }));
			json(await execute("cmux_surface", { action: "identify", workspace_id: workspaceId, surface_id: surfaceId }));
			const screen = await execute("cmux_surface", { action: "read", workspace_id: workspaceId, surface_id: surfaceId });
			expect(screen.content[0]?.text.length).toBeGreaterThan(0);

			await execute("cmux_sidebar", {
				action: "set_status",
				workspace_id: workspaceId,
				key: statusKey,
				value: "Typed GUI probe",
			});
			const sidebar = await execute("cmux_sidebar", { action: "state", workspace_id: workspaceId });
			expect(sidebar.content[0]?.text).toContain(`${statusKey}=Typed GUI probe`);

			await execute("cmux_notification", { action: "clear", workspace_id: workspaceId });
			await execute("cmux_notification", {
				action: "send",
				workspace_id: workspaceId,
				surface_id: surfaceId,
				title: "OMP typed GUI probe",
				body: "Owned plugin validation",
			});
			const notifications = json<Array<Record<string, unknown>>>(await execute("cmux_notification", { action: "list" }));
			expect(notifications.some(item => item.title === "OMP typed GUI probe")).toBe(true);

			const opened = json<Record<string, unknown>>(await execute("cmux_browser", {
				action: "open",
				workspace_id: workspaceId,
				arguments: ["about:blank"],
			}));
			browserSurface = typeof opened.surface_ref === "string" ? opened.surface_ref : undefined;
			expect(browserSurface).toMatch(/^surface:/);
			const url = await execute("cmux_browser", {
				action: "get_url",
				workspace_id: workspaceId,
				surface_id: browserSurface,
			});
			expect(url.content[0]?.text).toContain("about:blank");
			const snapshot = await execute("cmux_browser", {
				action: "snapshot",
				workspace_id: workspaceId,
				surface_id: browserSurface,
			});
			expect(snapshot.content[0]?.text.length).toBeGreaterThan(0);

			const rejectedTerminalAction = await invoke("cmux_surface", {
				action: "send_text",
				workspace_id: workspaceId,
				surface_id: browserSurface,
				text: "printf 'must-not-run\\n'\\n",
			});
			expect(rejectedTerminalAction.isError).toBe(true);
			expect(rejectedTerminalAction.content[0]?.text).toContain("terminal surface is required");
			const rejectedBrowserAction = await invoke("cmux_browser", {
				action: "snapshot",
				workspace_id: workspaceId,
				surface_id: surfaceId,
			});
			expect(rejectedBrowserAction.isError).toBe(true);
			expect(rejectedBrowserAction.content[0]?.text).toContain("browser surface is required");
		} finally {
			if (browserSurface) {
				await execute("cmux_surface", {
					action: "close",
					workspace_id: workspaceId,
					surface_id: browserSurface,
				});
			}
			await execute("cmux_sidebar", { action: "clear_status", workspace_id: workspaceId, key: statusKey });
			await execute("cmux_notification", { action: "clear", workspace_id: workspaceId });
		}
	},
	60_000,
);
