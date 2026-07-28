import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	exactTargetArgs,
	exactSurfaceTarget,
	parseCmuxJson,
	runCmux,
	type CmuxCommandResult,
	type CmuxTarget,
} from "./cmux";
import {
	CmuxBrowserSchema,
	CmuxCapabilitiesSchema,
	CmuxCliSchema,
	CmuxNotificationSchema,
	CmuxRpcSchema,
	CmuxSidebarSchema,
	CmuxSurfaceSchema,
	CmuxWorkspaceSchema,
	type CmuxBrowserInput,
	type CmuxCapabilitiesInput,
	type CmuxCliInput,
	type CmuxNotificationInput,
	type CmuxRpcInput,
	type CmuxSidebarInput,
	type CmuxSurfaceInput,
	type CmuxWorkspaceInput,
} from "./schemas";

interface CmuxToolDetails {
	operation: string;
	result?: CmuxCommandResult;
	json?: unknown;
	validationError?: string;
	jsonError?: string;
	target?: { workspaceId: string; surfaceId: string };
}
interface CmuxToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: CmuxToolDetails;
	isError: boolean;
}

type Runner = typeof runCmux;

interface LocalToolDefinition<TInput> {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(id: string, params: TInput, signal: AbortSignal | undefined): Promise<CmuxToolResult>;
}

function registerTool<TInput>(api: ExtensionAPI, definition: LocalToolDefinition<TInput>): void {
	api.registerTool(definition as never);
}

function required(value: string | undefined, name: string): string {
	if (value === undefined || value.trim() === "") throw new TypeError(`${name} is required for this action`);
	return value;
}

const TERMINAL_KEY_ALIASES: Record<string, string> = {
	ESC: "escape",
	ESCAPE: "escape",
	RETURN: "enter",
	ENTER: "enter",
	LEFT: "left",
	RIGHT: "right",
	UP: "up",
	DOWN: "down",
	TAB: "tab",
	BACKSPACE: "backspace",
	DELETE: "delete",
	SPACE: "space",
};

function normalizeTerminalKey(value: string | undefined): string {
	const key = required(value, "key").trim();
	const named = TERMINAL_KEY_ALIASES[key.toUpperCase()];
	if (named !== undefined) return named;
	const control = /^(?:C-|CTRL[_+-])(.+)$/i.exec(key);
	if (control?.[1]) return `ctrl+${control[1].toLowerCase()}`;
	return key.toLowerCase();
}

function appendOption(args: string[], flag: string, value: string | number | undefined): void {
	if (value !== undefined) args.push(flag, String(value));
}

function appendBooleanOption(args: string[], flag: string, value: boolean | undefined): void {
	if (value !== undefined) args.push(flag, value ? "true" : "false");
}

function targetOf(input: { workspace_id?: string; surface_id?: string; window_id?: string }): CmuxTarget {
	const target: CmuxTarget = {};
	if (input.workspace_id !== undefined) target.workspaceId = input.workspace_id;
	if (input.surface_id !== undefined) target.surfaceId = input.surface_id;
	if (input.window_id !== undefined) target.windowId = input.window_id;
	return target;
}

function windowArgs(windowId?: string): string[] {
	return windowId === undefined ? [] : ["--window", windowId];
}

function failureResult(message: string): CmuxToolResult {
	return {
		content: [{ type: "text", text: `Invalid cmux tool input: ${message}` }],
		details: { operation: "validation", validationError: message },
		isError: true,
	};
}

function resultText(result: CmuxCommandResult): string {
	const primary = result.ok ? result.stdout.trim() : (result.stderr.trim() || result.stdout.trim());
	let text = primary || (result.ok ? "cmux command completed successfully." : result.error?.message || "cmux command failed.");
	if (result.truncated.stdout || result.truncated.stderr) text += "\n[cmux output truncated at the configured byte limit]";
	return text;
}

const TERMINAL_READ_RETRY_DELAYS_MS = [100, 300, 750, 2_000] as const;
const TRANSIENT_TERMINAL_READ_ERROR = "Error: internal_error: Failed to read terminal text";

function isTransientTerminalRead(result: CmuxToolResult): boolean {
	const command = result.details.result;
	if (!command || command.ok) return false;
	return (command.stderr.trim() || command.stdout.trim()) === TRANSIENT_TERMINAL_READ_ERROR;
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return false;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	function finish(ready: boolean): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		resolve(ready);
	}
	const onAbort = () => finish(false);
	const timer = setTimeout(() => finish(true), delayMs);
	signal?.addEventListener("abort", onAbort, { once: true });
	return await promise;
}

async function executeCommand(
	operation: string,
	args: string[],
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	runner: Runner,
	options: { stdin?: string; requireJson?: boolean; parseJson?: boolean } = {},
): Promise<CmuxToolResult> {
	const result = await runner(args, {
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		...(signal === undefined ? {} : { signal }),
	});
	const details: CmuxToolDetails = { operation, result };
	let text = resultText(result);
	let jsonFailure = false;
	if (result.ok && (options.requireJson || options.parseJson) && result.stdout.trim()) {
		try {
			details.json = parseCmuxJson(result.stdout);
		} catch (error) {
			if (options.requireJson) {
				jsonFailure = true;
				details.jsonError = error instanceof Error ? error.message : "cmux returned invalid JSON output";
				text = details.jsonError;
			}
		}
	} else if (result.ok && options.requireJson) {
		jsonFailure = true;
		details.jsonError = "cmux returned empty JSON output";
		text = details.jsonError;
	}
	return {
		content: [{ type: "text", text }],
		details,
		isError: !result.ok || jsonFailure,
	};
}

function workspaceArgv(input: CmuxWorkspaceInput): string[] {
	const target = targetOf(input);
	switch (input.action) {
		case "list":
			return ["--json", "workspace", "list", ...windowArgs(input.window_id)];
		case "create": {
			const args = ["--json", "workspace", "create", ...windowArgs(input.window_id)];
			appendOption(args, "--name", input.name);
			appendOption(args, "--cwd", input.cwd);
			return args;
		}
		case "env":
			return ["--json", "workspace", "env", ...exactTargetArgs(target, "workspace"), ...(input.mask ? ["--mask"] : [])];
		case "close":
			return ["--json", "workspace", "close", ...exactTargetArgs(target, "workspace")];
		case "rename":
			return ["--json", "workspace", "rename", ...exactTargetArgs(target, "workspace"), "--title", required(input.title, "title")];
		case "select":
			return ["--json", "workspace", "select", ...exactTargetArgs(target, "workspace")];
		case "status":
			return ["--json", "workspace", "status", ...exactTargetArgs(target, "workspace")];
		case "status_set":
			return ["--json", "workspace", "status", "set", required(input.lane, "lane"), ...exactTargetArgs(target, "workspace")];
		case "status_cycle":
			return ["--json", "workspace", "status", "cycle", ...exactTargetArgs(target, "workspace")];
		case "reconnect":
			return ["--json", "workspace", "reconnect", ...exactTargetArgs(target, "workspace")];
		case "disconnect":
			return ["--json", "workspace", "disconnect", ...exactTargetArgs(target, "workspace")];
		case "loading": {
			if (input.enabled === undefined) throw new TypeError("enabled is required for loading");
			const args = ["--json", "workspace", "loading", input.enabled ? "on" : "off", ...exactTargetArgs(target, "workspace")];
			appendOption(args, "--id", input.loading_id);
			return args;
		}
		case "group":
			if (!input.group_args?.length) throw new TypeError("group_args must start with a workspace group subcommand");
			return ["--json", "workspace", "group", ...input.group_args];
	}
}

function surfaceArgv(input: CmuxSurfaceInput): string[] {
	const target = targetOf(input);
	switch (input.action) {
		case "list":
			return ["--json", "list-panels", ...exactTargetArgs(target, "workspace")];
		case "create": {
			if (input.type === "browser") {
				throw new TypeError("browser surfaces must be created with cmux_browser open or new");
			}
			const args = ["--json", "new-surface", ...exactTargetArgs(target, "workspace")];
			appendOption(args, "--type", input.type);
			appendOption(args, "--pane", input.pane_id);
			appendOption(args, "--placement", input.placement);
			appendOption(args, "--url", input.url);
			appendOption(args, "--provider", input.provider);
			appendOption(args, "--renderer", input.renderer);
			appendOption(args, "--working-directory", input.cwd);
			appendBooleanOption(args, "--focus", input.focus);
			return args;
		}
		case "split": {
			if (input.type !== undefined || input.url !== undefined || input.cwd !== undefined || input.pane_id !== undefined || input.placement !== undefined) {
				throw new TypeError("split accepts direction and focus; use create for type, URL, cwd, pane, or placement selection");
			}
			const args = ["--json", "new-split", required(input.direction, "direction"), ...exactTargetArgs(target, "surface")];
			appendBooleanOption(args, "--focus", input.focus);
			return args;
		}
		case "close":
			return ["--json", "close-surface", ...exactTargetArgs(target, "surface")];
		case "health":
			return ["--json", "surface-health", ...exactTargetArgs(target, "workspace")];
		case "identify":
			return ["--json", "identify", ...exactTargetArgs(target, "surface")];
		case "flash":
			return ["--json", "trigger-flash", ...exactTargetArgs(target, "surface")];
		case "read": {
			const args = ["--json", "read-screen", ...exactTargetArgs(target, "surface")];
			if (input.scrollback) args.push("--scrollback");
			appendOption(args, "--lines", input.lines);
			return args;
		}
		case "send_text":
			return ["--json", "send", ...exactTargetArgs(target, "surface"), "--", required(input.text, "text")];
		case "send_key":
			return ["--json", "send-key", ...exactTargetArgs(target, "surface"), "--", normalizeTerminalKey(input.key)];
		case "resume_show":
			return ["--json", "surface", "resume", "show", ...exactTargetArgs(target, "surface")];
		case "resume_clear":
			return ["--json", "surface", "resume", "clear", ...exactTargetArgs(target, "surface")];
		case "resume_set": {
			if (!input.command_argv?.length) throw new TypeError("command_argv is required for resume_set");
			const args = ["--json", "surface", "resume", "set", ...exactTargetArgs(target, "surface")];
			appendOption(args, "--cwd", input.cwd);
			appendOption(args, "--name", input.resume_name);
			appendOption(args, "--kind", input.resume_kind);
			appendOption(args, "--checkpoint-id", input.checkpoint_id);
			appendOption(args, "--source", input.resume_source);
			return [...args, "--", ...input.command_argv];
		}
	}
}

async function executeSurfaceCommand(
	input: CmuxSurfaceInput,
	signal: AbortSignal | undefined,
	runner: Runner,
): Promise<CmuxToolResult> {
	const argv = surfaceArgv(input);
	let output = await executeCommand(`surface:${input.action}`, argv, input.timeout_ms, signal, runner, { parseJson: true });
	if (input.action === "read") {
		for (const delayMs of TERMINAL_READ_RETRY_DELAYS_MS) {
			if (!isTransientTerminalRead(output) || !(await waitForRetry(delayMs, signal))) break;
			output = await executeCommand(`surface:${input.action}`, argv, input.timeout_ms, signal, runner, { parseJson: true });
		}
	}
	if (input.action === "close" && !output.isError) {
		const target = exactSurfaceTarget(targetOf(input));
		return {
			...output,
			content: [{ type: "text", text: `Closed surface ${target.surfaceId} in workspace ${target.workspaceId}.` }],
			details: { ...output.details, target },
		};
	}
	return output;
}

const BROWSER_COMMANDS: Record<CmuxBrowserInput["action"], string> = {
	open: "open", open_split: "open-split", new: "new", disable: "disable", enable: "enable", status: "status",
	goto: "goto", navigate: "navigate", back: "back", forward: "forward", reload: "reload", url: "url", get_url: "get-url",
	focus_webview: "focus-webview", is_webview_focused: "is-webview-focused", snapshot: "snapshot", eval: "eval", wait: "wait",
	click: "click", dblclick: "dblclick", hover: "hover", focus: "focus", check: "check", uncheck: "uncheck",
	scroll_into_view: "scroll-into-view", type: "type", fill: "fill", press: "press", key: "key", keydown: "keydown", keyup: "keyup",
	select: "select", scroll: "scroll", screenshot: "screenshot", get: "get", is: "is", find: "find", frame: "frame",
	dialog: "dialog", download: "download", profiles: "profiles", import: "import", cookies: "cookies", storage: "storage", tab: "tab",
	console: "console", errors: "errors", highlight: "highlight", state: "state", add_init_script: "addinitscript", add_script: "addscript",
	add_style: "addstyle", viewport: "viewport", geolocation: "geolocation", offline: "offline", trace: "trace", network: "network",
	screencast: "screencast", input: "input", input_mouse: "input_mouse", input_keyboard: "input_keyboard", input_touch: "input_touch",
	identify: "identify",
};

function browserArgv(input: CmuxBrowserInput): string[] {
	const command = BROWSER_COMMANDS[input.action];
	const nested = input.arguments ?? [];
	switch (input.action) {
		case "disable":
		case "enable":
		case "status":
		case "profiles":
		case "import":
			return ["--json", "browser", command, ...nested];
		case "open":
		case "open_split":
		case "new":
			return ["--json", "browser", command, ...nested, ...exactTargetArgs(targetOf(input), "workspace")];
		default: {
			const target = exactSurfaceTarget(targetOf(input));
			return ["--json", "browser", "--surface", target.surfaceId, command, ...nested];
		}
	}
}

function notificationArgv(input: CmuxNotificationInput): string[] {
	const target = targetOf(input);
	switch (input.action) {
		case "send": {
			const hasSurface = Boolean(input.surface_id ?? process.env.CMUX_SURFACE_ID);
			const args = ["--json", "notify", ...exactTargetArgs(target, hasSurface ? "surface" : "workspace")];
			appendOption(args, "--title", input.title);
			appendOption(args, "--subtitle", input.subtitle);
			appendOption(args, "--body", input.body);
			return args;
		}
		case "list":
			return ["--json", "list-notifications"];
		case "dismiss":
			if (input.notification_id && !input.all_read) return ["--json", "dismiss-notification", "--id", input.notification_id];
			if (!input.notification_id && input.all_read) return ["--json", "dismiss-notification", "--all-read"];
			throw new TypeError("dismiss requires exactly one of notification_id or all_read=true");
		case "mark_read": {
			if (input.notification_id && input.all) throw new TypeError("mark_read accepts notification_id or all=true, not both");
			if (input.notification_id) return ["--json", "mark-notification-read", "--id", input.notification_id];
			if (input.all) return ["--json", "mark-notification-read", "--all"];
			const args = ["--json", "mark-notification-read", ...exactTargetArgs(target, "workspace")];
			if (input.surface_id) args.push("--surface", input.surface_id);
			return args;
		}
		case "open":
			return ["--json", "open-notification", "--id", required(input.notification_id, "notification_id")];
		case "jump_to_unread":
			return ["--json", "jump-to-unread"];
		case "clear":
			return ["--json", "clear-notifications", ...exactTargetArgs(target, "workspace")];
	}
}

function sidebarArgv(input: CmuxSidebarInput): string[] {
	const target = targetOf(input);
	const routed = () => exactTargetArgs(target, "workspace");
	switch (input.action) {
		case "set_status": {
			const args = ["--json", "set-status", required(input.key, "key"), required(input.value, "value"), ...routed()];
			appendOption(args, "--icon", input.icon);
			appendOption(args, "--color", input.color);
			appendOption(args, "--priority", input.priority);
			return args;
		}
		case "clear_status": return ["--json", "clear-status", required(input.key, "key"), ...routed()];
		case "list_status": return ["--json", "list-status", ...routed()];
		case "set_progress": {
			if (input.progress === undefined) throw new TypeError("progress is required for set_progress");
			const args = ["--json", "set-progress", String(input.progress), ...routed()];
			appendOption(args, "--label", input.label);
			return args;
		}
		case "clear_progress": return ["--json", "clear-progress", ...routed()];
		case "log": {
			const args = ["--json", "log", ...routed()];
			appendOption(args, "--level", input.level);
			appendOption(args, "--source", input.source);
			return [...args, "--", required(input.message, "message")];
		}
		case "clear_log": return ["--json", "clear-log", ...routed()];
		case "list_log": {
			const args = ["--json", "list-log", ...routed()];
			appendOption(args, "--limit", input.limit);
			return args;
		}
		case "state": return ["--json", "sidebar-state", ...routed()];
		case "custom_validate":
		case "custom_reload": {
			const verb = input.action === "custom_validate" ? "validate" : "reload";
			if (input.name && input.all) throw new TypeError(`${input.action} accepts name or all=true, not both`);
			return ["--json", "sidebar", verb, ...(input.name ? [input.name] : []), ...(input.all ? ["--all"] : [])];
		}
		case "custom_select": return ["--json", "sidebar", "select", required(input.name, "name")];
		case "custom_open": return ["--json", "sidebar", "open", required(input.name, "name")];
		case "right_toggle": return ["--json", "right-sidebar", "toggle", ...routed()];
		case "right_show": return ["--json", "right-sidebar", "show", ...routed()];
		case "right_hide": return ["--json", "right-sidebar", "hide", ...routed()];
		case "right_focus": return ["--json", "right-sidebar", "focus", ...routed()];
		case "right_mode": return ["--json", "right-sidebar", "mode", ...routed()];
		case "right_set":
			return ["--json", "right-sidebar", "set", required(input.mode, "mode"), ...routed(), ...(input.no_focus ? ["--no-focus"] : [])];
	}
}

/** Register raw escape hatches and high-value typed cmux tools. */
export function registerCmuxTools(api: ExtensionAPI, options: { run?: Runner } = {}): void {
	const runner = options.run ?? runCmux;

	registerTool(api, {
		name: "cmux_capabilities",
		label: "cmux Capabilities",
		description: "Discover every RPC method and feature advertised by the connected cmux instance. Use this before raw RPC when method support is uncertain.",
		parameters: CmuxCapabilitiesSchema,
		async execute(_id, params: CmuxCapabilitiesInput, signal) {
			return executeCommand("capabilities", ["capabilities"], params.timeout_ms, signal, runner, { requireJson: true });
		},
	});

	registerTool(api, {
		name: "cmux_rpc",
		label: "cmux RPC",
		description: "Call any current or future cmux JSON-RPC method directly with a JSON object. This is the complete RPC escape hatch.",
		parameters: CmuxRpcSchema,
		async execute(_id, params: CmuxRpcInput, signal) {
			const argv = ["rpc", params.method];
			if (params.params !== undefined) argv.push(JSON.stringify(params.params));
			return executeCommand(`rpc:${params.method}`, argv, params.timeout_ms, signal, runner, { requireJson: true });
		},
	});

	registerTool(api, {
		name: "cmux_cli",
		label: "cmux CLI",
		description: "Prefer typed tools. Native GUI raw calls use top-level read-screen, close-surface, list-panels, and positional send-key KEY; never use surface read/close, list-surfaces, --key, or run without an argv array. open expects a local path, not file://; use browser goto for URLs. TUI syntax is separate and requires CMUX_TUI_SOCKET.",
		parameters: CmuxCliSchema,
		async execute(_id, params: CmuxCliInput, signal) {
			return executeCommand("cli", [...params.argv], params.timeout_ms, signal, runner, {
				...(params.stdin === undefined ? {} : { stdin: params.stdin }),
				parseJson: true,
			});
		},
	});

	registerTool(api, {
		name: "cmux_workspace",
		label: "cmux Workspace",
		description: "List, create, inspect, select, rename, close, reconnect, disconnect, or update a cmux workspace. Mutations require an explicit workspace identity or CMUX_WORKSPACE_ID.",
		parameters: CmuxWorkspaceSchema,
		async execute(_id, params: CmuxWorkspaceInput, signal) {
			try { return await executeCommand(`workspace:${params.action}`, workspaceArgv(params), params.timeout_ms, signal, runner, { parseJson: true }); }
			catch (error) { return failureResult(error instanceof Error ? error.message : "invalid workspace action"); }
		},
	});

	registerTool(api, {
		name: "cmux_surface",
		label: "cmux Surface",
		description: "Create terminal/agent surfaces, split, inspect, read, control, resume, or close surfaces. Create browser surfaces with cmux_browser open or new; native new-surface can report a browser that is not operable. Targeted actions require exact identities. Reads retry only the exact transient terminal startup error; close results name the requested target.",
		parameters: CmuxSurfaceSchema,
		async execute(_id, params: CmuxSurfaceInput, signal) {
			try { return await executeSurfaceCommand(params, signal, runner); }
			catch (error) { return failureResult(error instanceof Error ? error.message : "invalid surface action"); }
		},
	});

	registerTool(api, {
		name: "cmux_browser",
		label: "cmux Browser",
		description: "Use snapshot first, then standard CSS or a returned ref for browser actions; Playwright :has-text selectors are unsupported. WKWebView does not support network requests or input_mouse. Nested action arguments are an argv array, no shell parsing occurs, and exact surface routing is required.",
		parameters: CmuxBrowserSchema,
		async execute(_id, params: CmuxBrowserInput, signal) {
			try { return await executeCommand(`browser:${params.action}`, browserArgv(params), params.timeout_ms, signal, runner, { parseJson: true }); }
			catch (error) { return failureResult(error instanceof Error ? error.message : "invalid browser action"); }
		},
	});

	registerTool(api, {
		name: "cmux_notification",
		label: "cmux Notification",
		description: "Send, list, dismiss, mark, open, jump to, or clear cmux notifications. Sending and workspace clearing require exact target identities.",
		parameters: CmuxNotificationSchema,
		async execute(_id, params: CmuxNotificationInput, signal) {
			try { return await executeCommand(`notification:${params.action}`, notificationArgv(params), params.timeout_ms, signal, runner, { parseJson: true }); }
			catch (error) { return failureResult(error instanceof Error ? error.message : "invalid notification action"); }
		},
	});

	registerTool(api, {
		name: "cmux_sidebar",
		label: "cmux Sidebar",
		description: "Manage cmux sidebar status, progress, logs, custom sidebars, and right-sidebar visibility. Workspace-scoped operations use exact routing only.",
		parameters: CmuxSidebarSchema,
		async execute(_id, params: CmuxSidebarInput, signal) {
			try { return await executeCommand(`sidebar:${params.action}`, sidebarArgv(params), params.timeout_ms, signal, runner, { parseJson: true }); }
			catch (error) { return failureResult(error instanceof Error ? error.message : "invalid sidebar action"); }
		},
	});
}
