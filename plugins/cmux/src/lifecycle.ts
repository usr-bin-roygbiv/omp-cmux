import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { exactTargetArgs, runCmux } from "./cmux.ts";
import {
	LifecycleStateMachine,
	type LifecycleAction,
	type LifecycleEffect,
	type LifecycleSnapshot,
	type LifecycleStatus,
	type SubagentSnapshot,
	type TodoPhaseSnapshot,
} from "./state.ts";

const MAIN_STATUS_KEY = "omp_plugin";
const STATUS_PRIORITY = "100";
const AGENT_STATUS_PRIORITY = "80";
const TELEMETRY_INTERVAL_MS = 1_000;
const MAX_NOTIFICATION_KEYS = 512;
const REMOTE_CUSTOM_TYPE = "cmux_remote_notification_v1";

interface EventBusLike {
	on(channel: string, handler: (payload: unknown) => void): (() => void) | void;
}

interface ExtensionApiLike {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void;
	events?: EventBusLike;
	appendEntry?(customType: string, data?: unknown): void;
}

interface StatusStyle {
	icon: string;
	color: string;
}

interface Settlement {
	kind: "completion" | "input" | "blocked" | "error" | "suppress";
	text: string;
}

type NotificationKind = "input" | "approval" | "plan" | "completion" | "blocked" | "error";
type TuiAgentState = "working" | "blocked" | "idle" | "done" | "error" | "unknown";

const REMOTE_MESSAGES: Record<NotificationKind, string> = {
	input: "OMP is waiting for your response",
	approval: "OMP needs tool approval",
	plan: "Plan ready for approval",
	completion: "OMP turn completed",
	blocked: "OMP turn blocked",
	error: "OMP turn failed",
};

const STATUS_STYLES: Record<LifecycleStatus, StatusStyle> = {
	idle: { icon: "circle", color: "#8e8e93" },
	working: { icon: "gear", color: "#0a84ff" },
	thinking: { icon: "sparkle", color: "#bf5af2" },
	tool: { icon: "hammer", color: "#ff9f0a" },
	"needs-input": { icon: "questionmark.circle", color: "#ffd60a" },
	retrying: { icon: "arrow.clockwise", color: "#ff9f0a" },
	compacting: { icon: "archivebox", color: "#64d2ff" },
	waiting: { icon: "clock", color: "#ffd60a" },
	done: { icon: "checkmark.circle", color: "#30d158" },
	error: { icon: "exclamationmark.triangle", color: "#ff453a" },
	stopped: { icon: "stop.circle", color: "#8e8e93" },
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageRole(event: unknown): string | undefined {
	return text(record(record(event)?.message)?.role);
}

function messageFailed(event: unknown): boolean {
	const message = record(record(event)?.message);
	return Boolean(text(message?.errorMessage)) || text(message?.stopReason) === "error";
}

function todoPhases(value: unknown): TodoPhaseSnapshot[] | undefined {
	const outer = record(value);
	const details = record(outer?.details);
	const nestedResult = record(outer?.result);
	const nestedDetails = record(nestedResult?.details);
	const phases = details?.phases ?? nestedDetails?.phases ?? outer?.phases;
	return Array.isArray(phases) ? (phases as TodoPhaseSnapshot[]) : undefined;
}

function assistantOutcome(event: unknown): { cancelled: boolean; error: boolean } {
	const messages = record(event)?.messages;
	if (!Array.isArray(messages)) return { cancelled: false, error: false };
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = record(messages[index]);
		if (message?.role !== "assistant") continue;
		const stopReason = text(message.stopReason)?.toLowerCase();
		const errorMessage = text(message.errorMessage)?.toLowerCase();
		const cancelled = stopReason === "aborted" || stopReason === "cancelled" || Boolean(errorMessage?.includes("interrupted by user"));
		return { cancelled, error: !cancelled && Boolean(errorMessage) };
	}
	return { cancelled: false, error: false };
}

function safeContextPending(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.hasPendingMessages() ?? false;
	} catch {
		return false;
	}
}

function contextSessionId(ctx: ExtensionContext | undefined, eventSessionId?: unknown): string | undefined {
	const explicit = text(eventSessionId);
	if (explicit) return explicit;
	try {
		return text(ctx?.sessionManager.getSessionId());
	} catch {
		return undefined;
	}
}

function agentStatusKey(id: string): string {
	const normalized = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
	return `omp_agent_${normalized || "unknown"}`;
}

function agentActivity(agent: SubagentSnapshot): string {
	return agent.activity ? `${agent.name}: ${agent.activity}` : `${agent.name}: ${agent.status}`;
}

function agentStyle(status: SubagentSnapshot["status"]): StatusStyle {
	switch (status) {
		case "running": return { icon: "gear", color: "#0a84ff" };
		case "queued": return { icon: "clock", color: "#8e8e93" };
		case "idle": return { icon: "pause.circle", color: "#64d2ff" };
		case "parked": return { icon: "archivebox", color: "#8e8e93" };
		case "completed": return { icon: "checkmark.circle", color: "#30d158" };
		case "failed": return { icon: "exclamationmark.triangle", color: "#ff453a" };
	}
}

function lifecyclePayload(value: unknown): { id?: string; name?: string; status?: string; activity?: string } {
	const payload = record(value);
	if (!payload) return {};
	return {
		id: text(payload.id),
		name: text(payload.agent) ?? text(payload.name),
		status: text(payload.status),
		activity: text(payload.description),
	};
}

function progressPayload(value: unknown): { id?: string; name?: string; status?: string; activity?: string } {
	const payload = record(value);
	const progress = record(payload?.progress);
	if (!payload || !progress) return {};
	const retry = record(progress.retryState);
	const retryLabel = retry ? `retrying ${number(retry.attempt) ?? "?"}/${number(retry.maxAttempts) ?? "?"}` : undefined;
	const currentTool = text(progress.currentTool);
	return {
		id: text(progress.id) ?? text(payload.id),
		name: text(payload.agent) ?? text(progress.agent),
		status: text(progress.status),
		activity: (currentTool ? `tool: ${currentTool}` : undefined) ?? retryLabel ?? text(progress.lastIntent) ?? text(progress.description) ?? text(payload.task),
	};
}

function isAskToolName(value: unknown): value is string {
	return value === "ask" || (typeof value === "string" && value.endsWith(".ask"));
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.flatMap(block => {
		const typed = record(block);
		return typed?.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
	}).join("\n").trim();
}

function finalAssistantMessage(messages: unknown): unknown {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = record(messages[index]);
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function classifyFinalSettlement(message: unknown): Settlement {
	const typed = record(message);
	if (!typed) return { kind: "completion", text: "" };
	const content = textContent(typed.content);
	const stopReason = text(typed.stopReason)?.toLowerCase();
	const error = text(typed.errorMessage);
	const stopDetails = record(typed.stopDetails);
	const stopType = text(stopDetails?.type)?.toLowerCase();
	if (stopReason === "aborted" || stopReason === "cancelled" || stopReason === "tool_use" || (error && /\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b/i.test(error))) {
		return { kind: "suppress", text: error ?? content };
	}
	if (stopReason === "blocked" || stopType === "blocked" || stopType === "refusal" || stopType === "sensitive") {
		return { kind: "blocked", text: error ?? content };
	}
	if (error || stopReason === "error") return { kind: "error", text: error ?? (content || "OMP was blocked by an error") };
	const paragraphs = content.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
	const finalParagraph = paragraphs.at(-1) ?? "";
	if (finalParagraph.endsWith("?") || /^(?:(?:please|kindly)\s+)?(?:choose|confirm|enter|let me know|provide|reply|respond|select|send|share|tell me)\b/i.test(finalParagraph)) {
		return { kind: "input", text: finalParagraph };
	}
	return { kind: "completion", text: content };
}

function isSuccessfulPlanProposal(toolName: unknown, result: unknown): boolean {
	if (toolName !== "write") return false;
	const details = record(record(result)?.details);
	const dispatch = record(details?.xdev);
	const proposal = record(dispatch?.inner);
	return dispatch?.tool === "propose" && dispatch.mode === "execute" && proposal?.planExists === true && Boolean(text(proposal.planFilePath)) && Boolean(text(proposal.title));
}

function tuiState(status: LifecycleStatus): TuiAgentState {
	switch (status) {
		case "idle": return "idle";
		case "done": return "done";
		case "error": return "error";
		case "needs-input":
		case "waiting": return "blocked";
		case "working":
		case "thinking":
		case "tool":
		case "retrying":
		case "compacting": return "working";
		case "stopped": return "unknown";
	}
}


function notificationPresentation(kind: NotificationKind, body: string): { title: string; body: string; level: "info" | "warning" | "error"; subtitle: string } {
	switch (kind) {
		case "input": return { title: "OMP needs your input", body: body || REMOTE_MESSAGES.input, level: "warning", subtitle: "Waiting" };
		case "approval": return { title: "OMP needs tool approval", body: body || REMOTE_MESSAGES.approval, level: "warning", subtitle: "Permission" };
		case "plan": return { title: "OMP plan ready", body: body || REMOTE_MESSAGES.plan, level: "info", subtitle: "Plan Ready" };
		case "completion": return { title: "OMP turn complete", body: body || REMOTE_MESSAGES.completion, level: "info", subtitle: "Completed" };
		case "blocked": return { title: "OMP turn blocked", body: body || REMOTE_MESSAGES.blocked, level: "warning", subtitle: "Blocked" };
		case "error": return { title: "OMP turn failed", body: body || REMOTE_MESSAGES.error, level: "error", subtitle: "Error" };
	}
}

/** Register root-UI lifecycle, telemetry, and semantic notifications for GUI cmux or cmux TUI. */
export function registerCmuxLifecycle(
	api: ExtensionAPI,
	options: { run?: typeof runCmux; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): () => Promise<void> {
	const looseApi = api as unknown as ExtensionApiLike;
	const machine = new LifecycleStateMachine();
	const ownedAgentKeys = new Set<string>();
	const unsubscribers: Array<() => void> = [];
	const delivered = new Set<string>();
	const deliveredOrder: string[] = [];
	const promptGenerationBySession = new Map<string, number>();
	const runner = options.run ?? runCmux;
	const targetEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
	const now = options.now ?? Date.now;
	const tuiRequested = Boolean(text(targetEnv.CMUX_TUI_SOCKET));
	const rawTuiSurface = text(targetEnv.CMUX_TUI_SURFACE_ID);
	const tuiSurface = rawTuiSurface && /^\d+$/.test(rawTuiSurface) ? rawTuiSurface : undefined;
	const backend: "tui" | "gui" | "none" = tuiRequested ? (tuiSurface ? "tui" : "none") : "gui";
	let workspaceArgs: string[] | undefined;
	let surfaceArgs: string[] | undefined;
	if (backend === "gui") {
		try { workspaceArgs = exactTargetArgs({}, "workspace", targetEnv); } catch { workspaceArgs = undefined; }
		try { surfaceArgs = exactTargetArgs({}, "surface", targetEnv); } catch { surfaceArgs = undefined; }
	}
	let lastContext: ExtensionContext | undefined;
	let rootActive = false;
	let disposed = false;
	let telemetryTimer: Timer | undefined;
	let lastTuiReport: string | undefined;
	let commandTail = Promise.resolve();

	const enqueue = (args: string[], binary?: string, allowDisposed = false): void => {
		if (!allowDisposed && disposed) return;
		commandTail = commandTail.then(async () => {
			await runner(args, { env: targetEnv, ...(binary ? { binary } : {}) });
		}).catch(() => undefined);
	};

	const remember = (key: string): boolean => {
		if (delivered.has(key)) return false;
		delivered.add(key);
		deliveredOrder.push(key);
		if (deliveredOrder.length > MAX_NOTIFICATION_KEYS) {
			const oldest = deliveredOrder.shift();
			if (oldest) delivered.delete(oldest);
		}
		return true;
	};

	const stopTelemetry = (): void => {
		if (!telemetryTimer) return;
		try { lastContext?.clearTimer(telemetryTimer); } catch { /* teardown is best effort */ }
		telemetryTimer = undefined;
	};

	const reportTui = (stateOverride?: TuiAgentState): void => {
		if (!rootActive || backend !== "tui" || !tuiSurface) return;
		const args = [
			"report-agent", "--surface", tuiSurface,
			"--state", stateOverride ?? tuiState(machine.snapshot.status),
			"--source", "socket",
		];
		const sessionId = contextSessionId(lastContext);
		if (sessionId) args.push("--session", sessionId);
		const signature = JSON.stringify(args);
		if (signature === lastTuiReport) return;
		lastTuiReport = signature;
		enqueue(args, targetEnv.CMUX_OMP_TUI_BINARY?.trim() || "cmux-tui");
	};

	const startTelemetry = (ctx: ExtensionContext): void => {
		if (telemetryTimer || backend !== "tui") return;
		telemetryTimer = ctx.setInterval(() => reportTui(), TELEMETRY_INTERVAL_MS);
	};

	const applyEffect = (effect: LifecycleEffect): void => {
		if (!rootActive) return;
		switch (effect.type) {
			case "status": {
				if (backend !== "gui" || !workspaceArgs) return;
				const style = STATUS_STYLES[effect.status];
				enqueue(["set-status", MAIN_STATUS_KEY, effect.text, "--icon", style.icon, "--color", style.color, "--priority", STATUS_PRIORITY, ...workspaceArgs]);
				return;
			}
			case "todo": {
				if (backend !== "gui" || !workspaceArgs) return;
				if (!effect.progress || effect.progress.total === 0) {
					enqueue(["clear-progress", ...workspaceArgs]);
					return;
				}
				const fraction = Math.min(1, Math.max(0, effect.progress.completed / effect.progress.total));
				const current = [effect.progress.currentPhase, effect.progress.currentItem].filter(Boolean).join(": ");
				enqueue(["set-progress", fraction.toFixed(4), "--label", current || `${effect.progress.completed}/${effect.progress.total} complete`, ...workspaceArgs]);
				return;
			}
			case "subagent": {
				if (backend !== "gui" || !workspaceArgs) return;
				const key = agentStatusKey(effect.agent.id);
				const isNew = !ownedAgentKeys.has(key);
				ownedAgentKeys.add(key);
				const style = agentStyle(effect.agent.status);
				enqueue(["set-status", key, agentActivity(effect.agent), "--icon", style.icon, "--color", style.color, "--priority", AGENT_STATUS_PRIORITY, ...workspaceArgs]);
				if (isNew) enqueue(["log", `${effect.agent.name} started`, ...workspaceArgs]);
				return;
			}
			case "subagent-remove": {
				if (backend !== "gui" || !workspaceArgs) return;
				const key = agentStatusKey(effect.id);
				ownedAgentKeys.delete(key);
				enqueue(["clear-status", key, ...workspaceArgs]);
				enqueue(["log", `${effect.name} ${effect.status}`, ...workspaceArgs]);
				return;
			}
			case "notify":
				// Semantic notifications are emitted from their authoritative OMP events below.
				return;
		}
	};

	const dispatch = (action: LifecycleAction, updateTui = true): void => {
		if (disposed || !rootActive) return;
		for (const effect of machine.dispatch(action)) applyEffect(effect);
		if (updateTui) reportTui();
	};

	const remoteTmuxContext = (ctx: ExtensionContext): boolean => ctx.hasUI === true && backend === "gui" && !surfaceArgs && Boolean(text(targetEnv.TMUX));
	const canNotify = (ctx: ExtensionContext): boolean => ctx.hasUI === true && ((backend === "tui" && Boolean(tuiSurface)) || Boolean(surfaceArgs) || remoteTmuxContext(ctx));

	const notifyOnce = (key: string, kind: NotificationKind, ctx: ExtensionContext, body: string): void => {
		if (!canNotify(ctx) || !remember(key)) return;
		const sessionId = contextSessionId(ctx);
		if (!sessionId) return;
		if (remoteTmuxContext(ctx)) {
			looseApi.appendEntry?.(REMOTE_CUSTOM_TYPE, {
				version: 1,
				kind,
				eventId: key,
				sessionId,
				timestamp: new Date(now()).toISOString(),
				message: REMOTE_MESSAGES[kind],
			});
			return;
		}
		const presentation = notificationPresentation(kind, body);
		if (backend === "tui" && tuiSurface) {
			enqueue(["notify", "--title", presentation.title, "--subtitle", presentation.subtitle, "--body", presentation.body, "--level", presentation.level, "--surface", tuiSurface], targetEnv.CMUX_OMP_TUI_BINARY?.trim() || "cmux-tui");
			return;
		}
		if (surfaceArgs) enqueue(["notify", "--title", presentation.title, "--subtitle", presentation.subtitle, "--body", presentation.body, ...surfaceArgs]);
	};

	const on = (event: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void => {
		looseApi.on(event, (payload, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI !== true) return;
			return handler(payload, ctx);
		});
	};

	const sessionStart = (_event: unknown, ctx: ExtensionContext): void => {
		rootActive = true;
		promptGenerationBySession.clear();
		lastTuiReport = undefined;
		dispatch({ type: "session-start" });
		startTelemetry(ctx);
	};
	on("session_start", sessionStart);
	on("session_switch", sessionStart);
	on("session_branch", sessionStart);
	on("before_agent_start", (event, ctx) => {
		if (!rootActive) sessionStart({ type: "session_start" }, ctx);
		startTelemetry(ctx);
		const sessionId = contextSessionId(ctx);
		if (sessionId) promptGenerationBySession.set(sessionId, (promptGenerationBySession.get(sessionId) ?? 0) + 1);
		dispatch({ type: "agent-start" });
	});
	on("agent_start", () => dispatch({ type: "turn-start" }));
	on("turn_start", () => dispatch({ type: "turn-start" }));
	on("message_start", event => dispatch({ type: "message-start", role: messageRole(event) }));
	on("message_end", event => dispatch({ type: "message-end", role: messageRole(event), isError: messageFailed(event) }));
	on("tool_execution_start", (event, ctx) => {
		const payload = record(event);
		const id = text(payload?.toolCallId) ?? text(payload?.id);
		const name = text(payload?.toolName) ?? text(payload?.name);
		if (id && name) dispatch({ type: "tool-start", id, name });
		if (id && isAskToolName(name)) {
			const sessionId = contextSessionId(ctx);
			if (sessionId) {
				if (backend === "gui" && surfaceArgs) enqueue(["trigger-flash", ...surfaceArgs]);
				notifyOnce(`${sessionId}:ask:${id}`, "input", ctx, "OMP is waiting for your response");
			}
		}
	});
	on("tool_approval_requested", (event, ctx) => {
		const sessionId = contextSessionId(ctx, event.sessionId);
		const id = text(event.toolCallId);
		const name = text(event.toolName) ?? "tool";
		if (sessionId && id) notifyOnce(`${sessionId}:approval:${id}`, "approval", ctx, `Approval needed for ${name}${text(event.reason) ? `: ${text(event.reason)}` : ""}`);
	});
	on("tool_execution_end", (event, ctx) => {
		const payload = record(event);
		const id = text(payload?.toolCallId) ?? text(payload?.id);
		const name = text(payload?.toolName) ?? text(payload?.name);
		const phases = name === "todo" ? todoPhases(payload?.result) : undefined;
		if (phases) dispatch({ type: "todo-result", phases });
		if (id) dispatch({ type: "tool-end", id, isError: boolean(payload?.isError) ?? false });
		if (id && !boolean(payload?.isError) && isSuccessfulPlanProposal(name, payload?.result)) {
			const sessionId = contextSessionId(ctx);
			if (sessionId) notifyOnce(`${sessionId}:plan-approval:${id}`, "plan", ctx, "Plan ready for approval");
		}
	});
	on("tool_result", event => {
		const payload = record(event);
		if (text(payload?.toolName) !== "todo") return;
		const phases = todoPhases({ details: payload?.details });
		if (phases) dispatch({ type: "todo-result", phases });
	});
	on("auto_retry_start", event => {
		const payload = record(event);
		dispatch({ type: "retry-start", attempt: number(payload?.attempt), maxAttempts: number(payload?.maxAttempts) });
	});
	on("auto_retry_end", event => {
		const payload = record(event);
		dispatch({ type: "retry-end", success: boolean(payload?.success) ?? false, finalError: text(payload?.finalError) });
	});
	on("auto_compaction_start", () => dispatch({ type: "compaction-start" }));
	on("session_before_compact", () => dispatch({ type: "compaction-start" }));
	on("session.compacting", () => dispatch({ type: "compaction-start" }));
	on("auto_compaction_end", event => {
		const payload = record(event);
		dispatch({ type: "compaction-end", error: Boolean(text(payload?.errorMessage)), aborted: boolean(payload?.aborted), willRetry: boolean(payload?.willRetry) });
	});
	on("session_compact", () => dispatch({ type: "compaction-end" }));
	on("agent_end", (event, ctx) => {
		const outcome = assistantOutcome(event);
		if (outcome.cancelled) dispatch({ type: "cancel" });
		dispatch({ type: "agent-end", pendingMessages: safeContextPending(ctx), isError: outcome.error });
	});
	on("session_stop", (event, ctx) => {
		if (!rootActive) return;
		stopTelemetry();
		const settlement = classifyFinalSettlement(event.last_assistant_message ?? finalAssistantMessage(event.messages));
		dispatch({ type: "session-stop", outcome: settlement.kind }, false);
		const state: TuiAgentState = settlement.kind === "completion" ? "done" : settlement.kind === "error" ? "error" : settlement.kind === "input" || settlement.kind === "blocked" ? "blocked" : "unknown";
		reportTui(state);
		if (!event.stop_hook_active && settlement.kind !== "suppress") {
			const sessionId = contextSessionId(ctx, event.session_id);
			if (sessionId) {
				const generation = promptGenerationBySession.get(sessionId) ?? 0;
				notifyOnce(`${sessionId}:prompt:${generation}:turn:${event.turn_id}`, settlement.kind, ctx, settlement.text);
			}
		}
	});

	const cleanupUi = (): void => {
		stopTelemetry();
		if (backend !== "gui" || !workspaceArgs) return;
		enqueue(["clear-status", MAIN_STATUS_KEY, ...workspaceArgs], undefined, true);
		enqueue(["clear-progress", ...workspaceArgs], undefined, true);
		for (const key of ownedAgentKeys) enqueue(["clear-status", key, ...workspaceArgs], undefined, true);
		ownedAgentKeys.clear();
	};

	on("session_shutdown", async () => {
		if (!rootActive) return;
		dispatch({ type: "shutdown" });
		cleanupUi();
		rootActive = false;
		disposed = true;
		await commandTail;
	});

	const subscribe = (channel: string, handler: (payload: unknown) => void): void => {
		const unsubscribe = looseApi.events?.on(channel, handler);
		if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
	};
	subscribe("task:subagent:lifecycle", payload => {
		if (!rootActive) return;
		const parsed = lifecyclePayload(payload);
		if (!parsed.id || !parsed.name || !parsed.status) return;
		dispatch({ type: "pending-messages", pending: safeContextPending(lastContext) });
		dispatch({ type: "subagent-lifecycle", id: parsed.id, name: parsed.name, status: parsed.status, activity: parsed.activity });
	});
	subscribe("task:subagent:progress", payload => {
		if (!rootActive) return;
		const parsed = progressPayload(payload);
		if (!parsed.id || !parsed.name) return;
		dispatch({ type: "pending-messages", pending: safeContextPending(lastContext) });
		dispatch({ type: "subagent-progress", id: parsed.id, name: parsed.name, status: parsed.status, activity: parsed.activity });
	});

	return async () => {
		if (disposed) {
			await commandTail;
			return;
		}
		for (const unsubscribe of unsubscribers.splice(0)) {
			try { unsubscribe(); } catch { /* extension teardown must not disturb OMP */ }
		}
		cleanupUi();
		rootActive = false;
		disposed = true;
		await commandTail;
	};
}
