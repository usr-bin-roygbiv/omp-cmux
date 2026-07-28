import { Type, type Static } from "./schema";

const SafeString = Type.String({ maxLength: 65_536, pattern: "^[^\\u0000]*$" });
const NonEmptyString = Type.String({ minLength: 1, maxLength: 65_536, pattern: "^[^\\u0000]+$" });
const Handle = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]+$" });
const Timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 }));
const Argv = Type.Array(SafeString, { maxItems: 512 });

export const CmuxCapabilitiesSchema = Type.Object(
	{ timeout_ms: Timeout },
	{ additionalProperties: false },
);

export const CmuxRpcSchema = Type.Object(
	{
		method: Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_.:-]+$" }),
		params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxCliSchema = Type.Object(
	{
		argv: Argv,
		stdin: Type.Optional(SafeString),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxWorkspaceSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("env"),
			Type.Literal("close"),
			Type.Literal("rename"),
			Type.Literal("select"),
			Type.Literal("status"),
			Type.Literal("status_set"),
			Type.Literal("status_cycle"),
			Type.Literal("reconnect"),
			Type.Literal("disconnect"),
			Type.Literal("loading"),
			Type.Literal("group"),
		]),
		workspace_id: Type.Optional(Handle),
		window_id: Type.Optional(Handle),
		name: Type.Optional(NonEmptyString),
		cwd: Type.Optional(NonEmptyString),
		title: Type.Optional(NonEmptyString),
		mask: Type.Optional(Type.Boolean()),
		lane: Type.Optional(Type.Union([
			Type.Literal("auto"),
			Type.Literal("todo"),
			Type.Literal("working"),
			Type.Literal("needs-attention"),
			Type.Literal("review"),
			Type.Literal("done"),
		])),
		enabled: Type.Optional(Type.Boolean()),
		loading_id: Type.Optional(NonEmptyString),
		group_args: Type.Optional(Argv),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxSurfaceSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("split"),
			Type.Literal("close"),
			Type.Literal("health"),
			Type.Literal("identify"),
			Type.Literal("flash"),
			Type.Literal("read"),
			Type.Literal("send_text"),
			Type.Literal("send_key"),
			Type.Literal("resume_show"),
			Type.Literal("resume_clear"),
			Type.Literal("resume_set"),
		]),
		workspace_id: Type.Optional(Handle),
		surface_id: Type.Optional(Handle),
		window_id: Type.Optional(Handle),
		pane_id: Type.Optional(Handle),
		type: Type.Optional(Object.assign(Type.Union([Type.Literal("terminal"), Type.Literal("browser"), Type.Literal("agent-session")]), { description: "Use terminal or agent-session here. Browser creation is rejected; use cmux_browser open or new." })),
		placement: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("dock")])),
		direction: Type.Optional(Type.Union([
			Type.Literal("left"),
			Type.Literal("right"),
			Type.Literal("up"),
			Type.Literal("down"),
		])),
		url: Type.Optional(NonEmptyString),
		provider: Type.Optional(NonEmptyString),
		renderer: Type.Optional(NonEmptyString),
		cwd: Type.Optional(NonEmptyString),
		focus: Type.Optional(Type.Boolean()),
		text: Type.Optional(SafeString),
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, pattern: "^[^\\u0000]+$", description: "Native positional key name. Common audited aliases such as CTRL_B, C-b, CTRL_C, ESC, ENTER, and LEFT are normalized." })),
		scrollback: Type.Optional(Type.Boolean()),
		lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
		resume_name: Type.Optional(NonEmptyString),
		resume_kind: Type.Optional(NonEmptyString),
		checkpoint_id: Type.Optional(NonEmptyString),
		resume_source: Type.Optional(NonEmptyString),
		command_argv: Type.Optional(Argv),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxBrowserSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("open"), Type.Literal("open_split"), Type.Literal("new"),
			Type.Literal("disable"), Type.Literal("enable"), Type.Literal("status"),
			Type.Literal("goto"), Type.Literal("navigate"), Type.Literal("back"),
			Type.Literal("forward"), Type.Literal("reload"), Type.Literal("url"),
			Type.Literal("get_url"), Type.Literal("focus_webview"), Type.Literal("is_webview_focused"),
			Type.Literal("snapshot"), Type.Literal("eval"), Type.Literal("wait"),
			Type.Literal("click"), Type.Literal("dblclick"), Type.Literal("hover"),
			Type.Literal("focus"), Type.Literal("check"), Type.Literal("uncheck"),
			Type.Literal("scroll_into_view"), Type.Literal("type"), Type.Literal("fill"),
			Type.Literal("press"), Type.Literal("key"), Type.Literal("keydown"),
			Type.Literal("keyup"), Type.Literal("select"), Type.Literal("scroll"),
			Type.Literal("screenshot"), Type.Literal("get"), Type.Literal("is"),
			Type.Literal("find"), Type.Literal("frame"), Type.Literal("dialog"),
			Type.Literal("download"), Type.Literal("profiles"), Type.Literal("import"),
			Type.Literal("cookies"), Type.Literal("storage"), Type.Literal("tab"),
			Type.Literal("console"), Type.Literal("errors"), Type.Literal("highlight"),
			Type.Literal("state"), Type.Literal("add_init_script"), Type.Literal("add_script"),
			Type.Literal("add_style"), Type.Literal("viewport"), Type.Literal("geolocation"),
			Type.Literal("offline"), Type.Literal("trace"), Type.Literal("network"),
			Type.Literal("screencast"), Type.Literal("input"), Type.Literal("input_mouse"),
			Type.Literal("input_keyboard"), Type.Literal("input_touch"), Type.Literal("identify"),
		]),
		workspace_id: Type.Optional(Handle),
		surface_id: Type.Optional(Handle),
		window_id: Type.Optional(Handle),
		arguments: Type.Optional(Type.Array(SafeString, { maxItems: 512, description: "Positional browser arguments. Use snapshot refs or standard CSS, never Playwright :has-text selectors. WKWebView does not support network requests or input_mouse." })),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxNotificationSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("send"),
			Type.Literal("list"),
			Type.Literal("dismiss"),
			Type.Literal("mark_read"),
			Type.Literal("open"),
			Type.Literal("jump_to_unread"),
			Type.Literal("clear"),
		]),
		workspace_id: Type.Optional(Handle),
		surface_id: Type.Optional(Handle),
		window_id: Type.Optional(Handle),
		notification_id: Type.Optional(Handle),
		title: Type.Optional(NonEmptyString),
		subtitle: Type.Optional(SafeString),
		body: Type.Optional(SafeString),
		all: Type.Optional(Type.Boolean()),
		all_read: Type.Optional(Type.Boolean()),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export const CmuxSidebarSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("set_status"), Type.Literal("clear_status"), Type.Literal("list_status"),
			Type.Literal("set_progress"), Type.Literal("clear_progress"),
			Type.Literal("log"), Type.Literal("clear_log"), Type.Literal("list_log"),
			Type.Literal("state"), Type.Literal("custom_validate"), Type.Literal("custom_reload"),
			Type.Literal("custom_select"), Type.Literal("custom_open"),
			Type.Literal("right_toggle"), Type.Literal("right_show"), Type.Literal("right_hide"),
			Type.Literal("right_focus"), Type.Literal("right_mode"), Type.Literal("right_set"),
		]),
		workspace_id: Type.Optional(Handle),
		window_id: Type.Optional(Handle),
		key: Type.Optional(NonEmptyString),
		value: Type.Optional(SafeString),
		icon: Type.Optional(NonEmptyString),
		color: Type.Optional(NonEmptyString),
		priority: Type.Optional(Type.Integer()),
		progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		label: Type.Optional(SafeString),
		message: Type.Optional(SafeString),
		level: Type.Optional(Type.Union([
			Type.Literal("info"), Type.Literal("progress"), Type.Literal("success"),
			Type.Literal("warning"), Type.Literal("error"),
		])),
		source: Type.Optional(NonEmptyString),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
		name: Type.Optional(NonEmptyString),
		all: Type.Optional(Type.Boolean()),
		mode: Type.Optional(Type.Union([
			Type.Literal("files"), Type.Literal("find"), Type.Literal("vault"),
			Type.Literal("sessions"), Type.Literal("feed"), Type.Literal("dock"),
		])),
		no_focus: Type.Optional(Type.Boolean()),
		timeout_ms: Timeout,
	},
	{ additionalProperties: false },
);

export type CmuxCapabilitiesInput = Static<typeof CmuxCapabilitiesSchema>;
export type CmuxRpcInput = Static<typeof CmuxRpcSchema>;
export type CmuxCliInput = Static<typeof CmuxCliSchema>;
export type CmuxWorkspaceInput = Static<typeof CmuxWorkspaceSchema>;
export type CmuxSurfaceInput = Static<typeof CmuxSurfaceSchema>;
export type CmuxBrowserInput = Static<typeof CmuxBrowserSchema>;
export type CmuxNotificationInput = Static<typeof CmuxNotificationSchema>;
export type CmuxSidebarInput = Static<typeof CmuxSidebarSchema>;
