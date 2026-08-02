import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	detectCmuxBackend,
	exactTargetArgs,
	exactSurfaceTarget,
	exactTuiSurfaceTarget,
	exactTuiWorkspaceTarget,
	parseCmuxJson,
	resolveCmuxBackendBinary,
	runCmux,
	type CmuxBackend,
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
import { CMUX_SOURCE_CONTRACT } from "./source-contracts";

type CmuxSourceContract = (typeof CMUX_SOURCE_CONTRACT)[CmuxBackend];

interface CmuxToolDetails {
	operation: string;
	backend?: CmuxBackend;
	result?: CmuxCommandResult;
	json?: unknown;
	validationError?: string;
	jsonError?: string;
	target?: { workspaceId: string; surfaceId: string };
	sourceContract?: CmuxSourceContract;
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

function formatSourceContract(backend: CmuxBackend, contract: CmuxSourceContract): string {
	const lines = [
		`Backend: ${backend}`,
		`Source: ${contract.source}`,
		`CLI commands (${contract.commands.length}): ${contract.commands.join(", ")}`,
	];
	if ("browserActions" in contract) {
		lines.push(`Browser actions (${contract.browserActions.length}): ${contract.browserActions.join(", ")}`);
	}
	if ("protocolCommands" in contract) {
		lines.push(`Protocol source: ${contract.protocolSource}`);
		lines.push(`Protocol commands (${contract.protocolCommands.length}): ${contract.protocolCommands.join(", ")}`);
	}
	return lines.join("\n");
}

const TERMINAL_READ_RETRY_DELAYS_MS = [100, 300, 750, 2_000] as const;
const TRANSIENT_TERMINAL_READ_ERROR = "Error: internal_error: Failed to read terminal text";
const GUI_IDENTITY_PREFLIGHT_RETRY_DELAYS_MS = [50, 150] as const;

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
	context: { backend: CmuxBackend; env: NodeJS.ProcessEnv },
	options: { stdin?: string; requireJson?: boolean; parseJson?: boolean; sourceContract?: CmuxSourceContract } = {},
): Promise<CmuxToolResult> {
	const result = await runner(args, {
		binary: resolveCmuxBackendBinary(context.backend, context.env),
		env: context.env,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		...(signal === undefined ? {} : { signal }),
	});
	const details: CmuxToolDetails = {
		operation,
		backend: context.backend,
		result,
		...(options.sourceContract === undefined ? {} : { sourceContract: options.sourceContract }),
	};
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
	if (result.ok && !jsonFailure && options.sourceContract) {
		text = `${text}\n\n${formatSourceContract(context.backend, options.sourceContract)}`;
	}
	return {
		content: [{ type: "text", text }],
		details,
		isError: !result.ok || jsonFailure,
	};
}

type GuiSurfaceType = "terminal" | "browser";

function browserActionTargetsExistingSurface(action: CmuxBrowserInput["action"]): boolean {
	switch (action) {
		case "disable":
		case "enable":
		case "status":
		case "profiles":
		case "import":
		case "open":
		case "open_split":
		case "new":
			return false;
		default:
			return true;
	}
}


function guiSurfaceIdentityRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	const caller = root.caller;
	if (caller !== null && typeof caller === "object" && !Array.isArray(caller)) return caller as Record<string, unknown>;
	return root;
}

function normalizedGuiSurfaceType(identity: Record<string, unknown>): { raw: string; type: GuiSurfaceType } | undefined {
	let raw: string | undefined;
	for (const key of ["type", "kind", "surface_type"] as const) {
		const value = identity[key];
		if (typeof value === "string" && value.trim()) {
			raw = value.trim();
			break;
		}
	}
	if (raw === undefined) return undefined;
	switch (raw.toLowerCase()) {
		case "terminal":
		case "pty":
			return { raw, type: "terminal" };
		case "browser":
			return { raw, type: "browser" };
		default:
			return undefined;
	}
}

async function requireExactGuiSurfaceType(
	target: CmuxTarget,
	expectedType: GuiSurfaceType,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	runner: Runner,
	context: { backend: CmuxBackend; env: NodeJS.ProcessEnv },
): Promise<void> {
	const exact = exactSurfaceTarget(target, context.env);
	const argv = ["--json", "--id-format", "both", "identify", "--workspace", exact.workspaceId, "--surface", exact.surfaceId];
	let preflight = await executeCommand(
		"surface:identity-preflight",
		argv,
		timeoutMs,
		signal,
		runner,
		context,
		{ requireJson: true },
	);
	for (const delayMs of GUI_IDENTITY_PREFLIGHT_RETRY_DELAYS_MS) {
		if (!preflight.isError || !(await waitForRetry(delayMs, signal))) break;
		preflight = await executeCommand(
			"surface:identity-preflight",
			argv,
			timeoutMs,
			signal,
			runner,
			context,
			{ requireJson: true },
		);
	}
	if (preflight.isError) {
		throw new TypeError("cmux GUI exact-target preflight failed: identity unavailable");
	}
	const record = guiSurfaceIdentityRecord(preflight.details.json);
	if (!record) {
		throw new TypeError("cmux GUI exact-target preflight failed: malformed identity");
	}
	const identifiedWorkspaces = [record.workspace_id, record.workspace_ref]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	const identifiedSurfaces = [record.surface_id, record.surface_ref]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	if (identifiedWorkspaces.length === 0 || identifiedSurfaces.length === 0) {
		throw new TypeError("cmux GUI exact-target preflight failed: malformed identity");
	}
	if (!identifiedWorkspaces.includes(exact.workspaceId) || !identifiedSurfaces.includes(exact.surfaceId)) {
		throw new TypeError("cmux GUI exact-target preflight failed: identity mismatch");
	}
	const identifiedType = normalizedGuiSurfaceType(record);
	if (!identifiedType || identifiedType.type !== expectedType) {
		throw new TypeError(`cmux GUI exact-target preflight failed: ${expectedType} surface is required`);
	}
}

function workspaceArgv(input: CmuxWorkspaceInput, env: NodeJS.ProcessEnv): string[] {
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
			return ["--json", "workspace", "env", ...exactTargetArgs(target, "workspace", env), ...(input.mask ? ["--mask"] : [])];
		case "close":
			return ["--json", "workspace", "close", ...exactTargetArgs(target, "workspace", env)];
		case "rename":
			return ["--json", "workspace", "rename", ...exactTargetArgs(target, "workspace", env), "--title", required(input.title, "title")];
		case "select":
			return ["--json", "workspace", "select", ...exactTargetArgs(target, "workspace", env)];
		case "status":
			return ["--json", "workspace", "status", ...exactTargetArgs(target, "workspace", env)];
		case "status_set":
			return ["--json", "workspace", "status", "set", required(input.lane, "lane"), ...exactTargetArgs(target, "workspace", env)];
		case "status_cycle":
			return ["--json", "workspace", "status", "cycle", ...exactTargetArgs(target, "workspace", env)];
		case "reconnect":
			return ["--json", "workspace", "reconnect", ...exactTargetArgs(target, "workspace", env)];
		case "disconnect":
			return ["--json", "workspace", "disconnect", ...exactTargetArgs(target, "workspace", env)];
		case "loading": {
			if (input.enabled === undefined) throw new TypeError("enabled is required for loading");
			const args = ["--json", "workspace", "loading", input.enabled ? "on" : "off", ...exactTargetArgs(target, "workspace", env)];
			appendOption(args, "--id", input.loading_id);
			return args;
		}
		case "group":
			if (!input.group_args?.length) throw new TypeError("group_args must start with a workspace group subcommand");
			return ["--json", "workspace", "group", ...input.group_args];
	}
}

function tuiWorkspaceArgv(input: CmuxWorkspaceInput, env: NodeJS.ProcessEnv): string[] {
	switch (input.action) {
		case "list":
			return ["--json", "list-workspaces"];
		case "create": {
			if (input.cwd || input.window_id) throw new TypeError("workspace create cwd and window routing are not supported by cmux TUI; use cmux_cli");
			const args = ["--json", "new-workspace"];
			appendOption(args, "--name", input.name);
			return args;
		}
		case "close":
			return ["--json", "close-workspace", "--workspace", exactTuiWorkspaceTarget(input.workspace_id, env)];
		case "rename":
			return ["--json", "rename-workspace", "--workspace", exactTuiWorkspaceTarget(input.workspace_id, env), "--name", required(input.title, "title")];
		default:
			throw new TypeError(`workspace ${input.action} is not supported by cmux TUI; use cmux_cli with a source-listed TUI command`);
	}
}

function surfaceArgv(input: CmuxSurfaceInput, env: NodeJS.ProcessEnv): string[] {
	const target = targetOf(input);
	switch (input.action) {
		case "list":
			return ["--json", "list-panels", ...exactTargetArgs(target, "workspace", env)];
		case "create": {
			if (input.type === "browser") {
				throw new TypeError("browser surfaces must be created with cmux_browser open or new");
			}
			const args = ["--json", "new-surface", ...exactTargetArgs(target, "workspace", env)];
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
			const args = ["--json", "new-split", required(input.direction, "direction"), ...exactTargetArgs(target, "surface", env)];
			appendBooleanOption(args, "--focus", input.focus);
			return args;
		}
		case "close":
			return ["--json", "close-surface", ...exactTargetArgs(target, "surface", env)];
		case "health":
			return ["--json", "surface-health", ...exactTargetArgs(target, "workspace", env)];
		case "identify":
			return ["--json", "identify", ...exactTargetArgs(target, "surface", env)];
		case "flash":
			return ["--json", "trigger-flash", ...exactTargetArgs(target, "surface", env)];
		case "read": {
			const args = ["--json", "read-screen", ...exactTargetArgs(target, "surface", env)];
			if (input.scrollback) args.push("--scrollback");
			appendOption(args, "--lines", input.lines);
			return args;
		}
		case "send_text":
			return ["--json", "send", ...exactTargetArgs(target, "surface", env), "--", required(input.text, "text")];
		case "send_key":
			return ["--json", "send-key", ...exactTargetArgs(target, "surface", env), "--", normalizeTerminalKey(input.key)];
		case "resume_show":
			return ["--json", "surface", "resume", "show", ...exactTargetArgs(target, "surface", env)];
		case "resume_clear":
			return ["--json", "surface", "resume", "clear", ...exactTargetArgs(target, "surface", env)];
		case "resume_set": {
			if (!input.command_argv?.length) throw new TypeError("command_argv is required for resume_set");
			const args = ["--json", "surface", "resume", "set", ...exactTargetArgs(target, "surface", env)];
			appendOption(args, "--cwd", input.cwd);
			appendOption(args, "--name", input.resume_name);
			appendOption(args, "--kind", input.resume_kind);
			appendOption(args, "--checkpoint-id", input.checkpoint_id);
			appendOption(args, "--source", input.resume_source);
			return [...args, "--", ...input.command_argv];
		}
	}
}

function tuiSurfaceArgv(input: CmuxSurfaceInput, env: NodeJS.ProcessEnv): string[] {
	const surface = () => exactTuiSurfaceTarget(input.surface_id, env);
	switch (input.action) {
		case "list":
			return ["--json", "list-workspaces"];
		case "create": {
			if (input.type && input.type !== "terminal") throw new TypeError(`surface type ${input.type} is not supported by cmux TUI; use cmux_browser for browser tabs`);
			if (!input.pane_id) throw new TypeError("pane_id is required for exact cmux TUI surface creation");
			if (input.placement || input.provider || input.renderer || input.focus !== undefined) throw new TypeError("surface placement, provider, renderer, and focus are not supported by cmux TUI; use cmux_cli");
			const args = ["--json", "new-tab", "--pane", input.pane_id];
			appendOption(args, "--cwd", input.cwd);
			return args;
		}
		case "split":
			if (!input.pane_id) throw new TypeError("pane_id is required for exact cmux TUI pane splitting");
			if (input.focus !== undefined) throw new TypeError("split focus selection is not supported by cmux TUI; use cmux_cli");
			return ["--json", "split", "--pane", input.pane_id, "--dir", required(input.direction, "direction")];
		case "close":
			return ["--json", "close-surface", "--surface", surface()];
		case "identify":
			return ["--json", "identify"];
		case "read":
			if (input.scrollback) return ["--json", "read-scrollback", "--surface", surface(), "--start", "0", "--count", String(input.lines ?? 100)];
			if (input.lines !== undefined) throw new TypeError("visible TUI reads do not accept lines; use scrollback=true or cmux_cli");
			return ["--json", "read-screen", "--surface", surface()];
		case "send_text":
			return ["--json", "send", "--surface", surface(), "--text", required(input.text, "text")];
		case "send_key":
			return ["--json", "send-key", "--surface", surface(), normalizeTerminalKey(input.key)];
		default:
			throw new TypeError(`surface ${input.action} is not supported by cmux TUI; use cmux_cli with a source-listed TUI command`);
	}
}

async function executeSurfaceCommand(
	input: CmuxSurfaceInput,
	signal: AbortSignal | undefined,
	runner: Runner,
	context: { backend: CmuxBackend; env: NodeJS.ProcessEnv },
): Promise<CmuxToolResult> {
	const argv = context.backend === "tui" ? tuiSurfaceArgv(input, context.env) : surfaceArgv(input, context.env);
	if (context.backend === "gui" && (input.action === "send_text" || input.action === "send_key")) {
		await requireExactGuiSurfaceType(targetOf(input), "terminal", input.timeout_ms, signal, runner, context);
	}
	let output = await executeCommand(`surface:${input.action}`, argv, input.timeout_ms, signal, runner, context, { parseJson: true });
	if (input.action === "read") {
		for (const delayMs of TERMINAL_READ_RETRY_DELAYS_MS) {
			if (!isTransientTerminalRead(output) || !(await waitForRetry(delayMs, signal))) break;
			output = await executeCommand(`surface:${input.action}`, argv, input.timeout_ms, signal, runner, context, { parseJson: true });
		}
	}
	if (input.action === "close" && !output.isError && context.backend === "gui") {
		const target = exactSurfaceTarget(targetOf(input), context.env);
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

function browserArgv(input: CmuxBrowserInput, env: NodeJS.ProcessEnv): string[] {
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
			return ["--json", "browser", command, ...nested, ...exactTargetArgs(targetOf(input), "workspace", env)];
		default: {
			const target = exactSurfaceTarget(targetOf(input), env);
			return ["--json", "browser", "--surface", target.surfaceId, command, ...nested];
		}
	}
}

function tuiBrowserArgv(input: CmuxBrowserInput): string[] {
	if (input.action !== "open" && input.action !== "new") {
		throw new TypeError(`${input.action} is not supported by cmux TUI browser surfaces; use cmux_cli for source-listed TUI commands`);
	}
	const args = input.arguments ?? [];
	const paneIndex = args.indexOf("--pane");
	if (paneIndex < 0 || !args[paneIndex + 1]) throw new TypeError("cmux TUI browser creation requires an explicit --pane argument");
	return ["--json", "new-browser-tab", ...args];
}

function notificationArgv(input: CmuxNotificationInput, env: NodeJS.ProcessEnv): string[] {
	const target = targetOf(input);
	switch (input.action) {
		case "send": {
			if (input.level) throw new TypeError("notification level is supported by cmux TUI only");
			const hasSurface = Boolean(input.surface_id ?? env.CMUX_SURFACE_ID);
			const args = ["--json", "notify", ...exactTargetArgs(target, hasSurface ? "surface" : "workspace", env)];
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
			const args = ["--json", "mark-notification-read", ...exactTargetArgs(target, "workspace", env)];
			if (input.surface_id) args.push("--surface", input.surface_id);
			return args;
		}
		case "open":
			return ["--json", "open-notification", "--id", required(input.notification_id, "notification_id")];
		case "jump_to_unread":
			return ["--json", "jump-to-unread"];
		case "clear":
			return ["--json", "clear-notifications", ...exactTargetArgs(target, "workspace", env)];
	}
}

function tuiNotificationArgv(input: CmuxNotificationInput, env: NodeJS.ProcessEnv): string[] {
	if (input.action !== "send") throw new TypeError(`notification ${input.action} is not supported by cmux TUI; use cmux_cli`);
	if (input.subtitle) throw new TypeError("notification subtitles are not supported by this cmux TUI protocol; use title and body");
	const args = [
		"--json",
		"notify",
		"--title",
		required(input.title, "title"),
		"--body",
		required(input.body, "body"),
	];
	appendOption(args, "--level", input.level);
	args.push("--surface", exactTuiSurfaceTarget(input.surface_id, env));
	return args;
}

function sidebarArgv(input: CmuxSidebarInput, env: NodeJS.ProcessEnv): string[] {
	const target = targetOf(input);
	const routed = () => exactTargetArgs(target, "workspace", env);
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

function toolContext(env: NodeJS.ProcessEnv): { backend: CmuxBackend; env: NodeJS.ProcessEnv } {
	return { backend: detectCmuxBackend(env), env };
}

function actionSubsetSchema(schema: unknown, actions: readonly string[]): unknown {
	const objectSchema = schema as {
		properties?: Record<string, unknown> & { action?: { anyOf?: Array<{ const?: unknown }> } };
	};
	const properties = objectSchema.properties;
	const action = properties?.action;
	if (!properties || !action?.anyOf) throw new TypeError("cmux action schema is malformed");
	return {
		...objectSchema,
		properties: {
			...properties,
			action: {
				...action,
				anyOf: action.anyOf.filter(entry => typeof entry.const === "string" && actions.includes(entry.const)),
			},
		},
	};
}

/** Register raw escape hatches and high-value typed cmux tools. */
export function registerCmuxTools(api: ExtensionAPI, options: { run?: Runner; env?: NodeJS.ProcessEnv } = {}): void {
	const runner = options.run ?? runCmux;
	const env = options.env ?? process.env;
	let registeredBackend: CmuxBackend;
	try { registeredBackend = detectCmuxBackend(env); } catch { return; }
	const isTuiBackend = registeredBackend === "tui";
	const activeBackendLabel = isTuiBackend ? "cmux TUI" : "cmux GUI";


	registerTool(api, {
		name: "cmux_capabilities",
		label: "cmux Capabilities",
		description: "Detect the active GUI or TUI backend and discover its native capabilities plus the source-derived command inventory.",
		parameters: CmuxCapabilitiesSchema,
		async execute(_id, params: CmuxCapabilitiesInput, signal) {
			try {
				const context = toolContext(env);
				const sourceContract = CMUX_SOURCE_CONTRACT[context.backend];
				const argv = context.backend === "tui" ? ["--json", "identify"] : ["capabilities"];
				return await executeCommand("capabilities", argv, params.timeout_ms, signal, runner, context, { requireJson: true, sourceContract });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "unable to detect cmux backend");
			}
		},
	});

	if (!isTuiBackend) registerTool(api, {
		name: "cmux_rpc",
		label: "cmux RPC",
		description: "Call any current or future cmux GUI JSON-RPC method directly.",
		parameters: CmuxRpcSchema,
		async execute(_id, params: CmuxRpcInput, signal) {
			try {
				const context = toolContext(env);
				const argv = ["rpc", params.method];
				if (params.params !== undefined) argv.push(JSON.stringify(params.params));
				return await executeCommand(`rpc:${params.method}`, argv, params.timeout_ms, signal, runner, context, { requireJson: true });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid RPC action");
			}
		},
	});

	registerTool(api, {
		name: "cmux_cli",
		label: "cmux CLI",
		description: `Run any source-listed or future command against ${activeBackendLabel} as an explicit argv array, never through a shell. Native read-screen and close-surface syntax uses positional values where documented; local paths may use file:// URLs.`,
		parameters: CmuxCliSchema,
		async execute(_id, params: CmuxCliInput, signal) {
			try {
				const context = toolContext(env);
				return await executeCommand("cli", [...params.argv], params.timeout_ms, signal, runner, context, {
					...(params.stdin === undefined ? {} : { stdin: params.stdin }),
					parseJson: true,
				});
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid CLI action");
			}
		},
	});

	registerTool(api, {
		name: "cmux_workspace",
		label: "cmux Workspace",
		description: `Manage workspaces through exact ${activeBackendLabel} routing.`,
		parameters: isTuiBackend ? actionSubsetSchema(CmuxWorkspaceSchema, ["list", "create", "close", "rename"]) : CmuxWorkspaceSchema,
		async execute(_id, params: CmuxWorkspaceInput, signal) {
			try {
				const context = toolContext(env);
				const argv = context.backend === "tui" ? tuiWorkspaceArgv(params, env) : workspaceArgv(params, env);
				return await executeCommand(`workspace:${params.action}`, argv, params.timeout_ms, signal, runner, context, { parseJson: true });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid workspace action");
			}
		},
	});

	registerTool(api, {
		name: "cmux_surface",
		label: "cmux Surface",
		description: `Create, split, inspect, read, control, resume, or close surfaces through ${activeBackendLabel} with exact identities.`,
		parameters: isTuiBackend ? actionSubsetSchema(CmuxSurfaceSchema, ["list", "create", "split", "close", "identify", "read", "send_text", "send_key"]) : CmuxSurfaceSchema,
		async execute(_id, params: CmuxSurfaceInput, signal) {
			try {
				return await executeSurfaceCommand(params, signal, runner, toolContext(env));
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid surface action");
			}
		},
	});

	registerTool(api, {
		name: "cmux_browser",
		label: "cmux Browser",
		description: isTuiBackend ? "Create an exact cmux TUI Chromium/CDP browser tab. DOM automation is unavailable on this backend." : "Use the complete command set for the current native cmux GUI browser engine. Call cmux_capabilities before engine-specific network or input_mouse actions; automation uses snapshot refs or standard CSS rather than :has-text.",
		parameters: isTuiBackend ? actionSubsetSchema(CmuxBrowserSchema, ["open", "new"]) : CmuxBrowserSchema,
		async execute(_id, params: CmuxBrowserInput, signal) {
			try {
				const context = toolContext(env);
				const argv = context.backend === "tui" ? tuiBrowserArgv(params) : browserArgv(params, env);
				if (context.backend === "gui" && browserActionTargetsExistingSurface(params.action)) {
					await requireExactGuiSurfaceType(targetOf(params), "browser", params.timeout_ms, signal, runner, context);
				}
				return await executeCommand(`browser:${params.action}`, argv, params.timeout_ms, signal, runner, context, { parseJson: true });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid browser action");
			}
		},
	});

	registerTool(api, {
		name: "cmux_notification",
		label: "cmux Notification",
		description: isTuiBackend ? "Send a native cmux TUI notification." : "Send and manage native cmux GUI notifications.",
		parameters: isTuiBackend ? actionSubsetSchema(CmuxNotificationSchema, ["send"]) : CmuxNotificationSchema,
		async execute(_id, params: CmuxNotificationInput, signal) {
			try {
				const context = toolContext(env);
				const argv = context.backend === "tui" ? tuiNotificationArgv(params, env) : notificationArgv(params, env);
				return await executeCommand(`notification:${params.action}`, argv, params.timeout_ms, signal, runner, context, { parseJson: true });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid notification action");
			}
		},
	});

	if (!isTuiBackend) registerTool(api, {
		name: "cmux_sidebar",
		label: "cmux Sidebar",
		description: "Manage cmux GUI sidebar status, progress, logs, custom sidebars, and right-sidebar visibility.",
		parameters: CmuxSidebarSchema,
		async execute(_id, params: CmuxSidebarInput, signal) {
			try {
				const context = toolContext(env);
				return await executeCommand(`sidebar:${params.action}`, sidebarArgv(params, env), params.timeout_ms, signal, runner, context, { parseJson: true });
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid sidebar action");
			}
		},
	});
}
