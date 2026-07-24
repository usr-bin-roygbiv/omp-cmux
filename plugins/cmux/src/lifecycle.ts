import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { exactTargetArgs, runCmux } from "./cmux.ts";
import {
	LifecycleStateMachine,
	type LifecycleAction,
	type LifecycleEffect,
	type LifecycleStatus,
	type SubagentSnapshot,
	type TodoPhaseSnapshot,
} from "./state.ts";

const MAIN_STATUS_KEY = "omp_plugin";
const STATUS_PRIORITY = "100";
const AGENT_STATUS_PRIORITY = "80";

interface EventBusLike {
	on(channel: string, handler: (payload: unknown) => void): (() => void) | void;
}

interface ExtensionApiLike {
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	events?: EventBusLike;
}

interface StatusStyle {
	icon: string;
	color: string;
}

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

function agentStatusKey(id: string): string {
	const normalized = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
	return `omp_agent_${normalized || "unknown"}`;
}

function agentActivity(agent: SubagentSnapshot): string {
	return agent.activity ? `${agent.name}: ${agent.activity}` : `${agent.name}: ${agent.status}`;
}

function agentStyle(status: SubagentSnapshot["status"]): StatusStyle {
	switch (status) {
		case "running":
			return { icon: "gear", color: "#0a84ff" };
		case "queued":
			return { icon: "clock", color: "#8e8e93" };
		case "idle":
			return { icon: "pause.circle", color: "#64d2ff" };
		case "parked":
			return { icon: "archivebox", color: "#8e8e93" };
		case "completed":
			return { icon: "checkmark.circle", color: "#30d158" };
		case "failed":
			return { icon: "exclamationmark.triangle", color: "#ff453a" };
	}
}

function lifecyclePayload(value: unknown): {
	id?: string;
	name?: string;
	status?: string;
	activity?: string;
} {
	const payload = record(value);
	if (!payload) return {};
	return {
		id: text(payload.id),
		name: text(payload.agent) ?? text(payload.name),
		status: text(payload.status),
		activity: text(payload.description),
	};
}

function progressPayload(value: unknown): {
	id?: string;
	name?: string;
	status?: string;
	activity?: string;
} {
	const payload = record(value);
	const progress = record(payload?.progress);
	if (!payload || !progress) return {};
	const retry = record(progress.retryState);
	const retryLabel = retry
		? `retrying ${number(retry.attempt) ?? "?"}/${number(retry.maxAttempts) ?? "?"}`
		: undefined;
	const currentTool = text(progress.currentTool);
	return {
		id: text(progress.id) ?? text(payload.id),
		name: text(payload.agent) ?? text(progress.agent),
		status: text(progress.status),
		activity:
			(currentTool ? `tool: ${currentTool}` : undefined) ??
			retryLabel ??
			text(progress.lastIntent) ??
			text(progress.description) ??
			text(payload.task),
	};
}

/** Register exact-target cmux status, todo, subagent, and notification synchronization. */
export function registerCmuxLifecycle(
	api: ExtensionAPI,
	options: { run?: typeof runCmux; env?: NodeJS.ProcessEnv } = {},
): () => Promise<void> {
	const looseApi = api as unknown as ExtensionApiLike;
	const machine = new LifecycleStateMachine();
	const ownedAgentKeys = new Set<string>();
	const unsubscribers: Array<() => void> = [];
	const runner = options.run ?? runCmux;
	const targetEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
	let lastContext: ExtensionContext | undefined;
	let disposed = false;
	let commandTail = Promise.resolve();

	let workspaceArgs: string[] | undefined;
	let surfaceArgs: string[] | undefined;
	try {
		workspaceArgs = exactTargetArgs({}, "workspace", targetEnv);
	} catch {
		workspaceArgs = undefined;
	}
	try {
		surfaceArgs = exactTargetArgs({}, "surface", targetEnv);
	} catch {
		surfaceArgs = undefined;
	}

	const enqueue = (args: string[], allowDisposed = false): void => {
		if ((!allowDisposed && disposed) || !workspaceArgs) return;
		commandTail = commandTail
			.then(async () => {
				await runner(args, { env: targetEnv });
			})
			.catch(() => undefined);
	};

	const applyEffect = (effect: LifecycleEffect): void => {
		switch (effect.type) {
			case "status": {
				if (!workspaceArgs) return;
				const style = STATUS_STYLES[effect.status];
				enqueue([
					"set-status",
					MAIN_STATUS_KEY,
					effect.text,
					"--icon",
					style.icon,
					"--color",
					style.color,
					"--priority",
					STATUS_PRIORITY,
					...workspaceArgs,
				]);
				return;
			}
			case "todo": {
				if (!workspaceArgs) return;
				if (!effect.progress || effect.progress.total === 0) {
					enqueue(["clear-progress", ...workspaceArgs]);
					return;
				}
				const fraction = Math.min(1, Math.max(0, effect.progress.completed / effect.progress.total));
				const current = [effect.progress.currentPhase, effect.progress.currentItem].filter(Boolean).join(": ");
				const label = current || `${effect.progress.completed}/${effect.progress.total} complete`;
				enqueue(["set-progress", fraction.toFixed(4), "--label", label, ...workspaceArgs]);
				return;
			}
			case "subagent": {
				if (!workspaceArgs) return;
				const key = agentStatusKey(effect.agent.id);
				const isNew = !ownedAgentKeys.has(key);
				ownedAgentKeys.add(key);
				const style = agentStyle(effect.agent.status);
				enqueue([
					"set-status",
					key,
					agentActivity(effect.agent),
					"--icon",
					style.icon,
					"--color",
					style.color,
					"--priority",
					AGENT_STATUS_PRIORITY,
					...workspaceArgs,
				]);
				if (isNew) enqueue(["log", `${effect.agent.name} started`, ...workspaceArgs]);
				return;
			}
			case "subagent-remove": {
				if (!workspaceArgs) return;
				const key = agentStatusKey(effect.id);
				ownedAgentKeys.delete(key);
				enqueue(["clear-status", key, ...workspaceArgs]);
				enqueue(["log", `${effect.name} ${effect.status}`, ...workspaceArgs]);
				return;
			}
			case "notify": {
				if (!surfaceArgs) return;
				enqueue([
					"notify",
					"--title",
					effect.title,
					"--subtitle",
					effect.kind === "decision" ? "Decision needed" : "Completed",
					"--body",
					effect.body,
					...surfaceArgs,
				]);
			}
		}
	};

	const dispatch = (action: LifecycleAction): void => {
		if (disposed) return;
		for (const effect of machine.dispatch(action)) applyEffect(effect);
	};

	const on = (
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
	): void => {
		looseApi.on(event, (payload, ctx) => {
			lastContext = ctx;
			return handler(payload, ctx);
		});
	};

	on("session_start", () => dispatch({ type: "session-start" }));
	on("session_switch", () => dispatch({ type: "session-start" }));
	on("session_branch", () => dispatch({ type: "session-start" }));
	on("before_agent_start", () => dispatch({ type: "agent-start" }));
	on("agent_start", () => dispatch({ type: "turn-start" }));
	on("turn_start", () => dispatch({ type: "turn-start" }));
	on("message_start", event => dispatch({ type: "message-start", role: messageRole(event) }));
	on("message_end", event => dispatch({ type: "message-end", role: messageRole(event), isError: messageFailed(event) }));
	on("tool_execution_start", event => {
		const payload = record(event);
		const id = text(payload?.toolCallId) ?? text(payload?.id);
		const name = text(payload?.toolName) ?? text(payload?.name);
		if (id && name) dispatch({ type: "tool-start", id, name });
	});
	on("tool_execution_end", event => {
		const payload = record(event);
		const id = text(payload?.toolCallId) ?? text(payload?.id);
		const name = text(payload?.toolName) ?? text(payload?.name);
		const phases = name === "todo" ? todoPhases(payload?.result) : undefined;
		if (phases) dispatch({ type: "todo-result", phases });
		if (id) dispatch({ type: "tool-end", id, isError: boolean(payload?.isError) ?? false });
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
		dispatch({
			type: "retry-end",
			success: boolean(payload?.success) ?? false,
			finalError: text(payload?.finalError),
		});
	});
	on("auto_compaction_start", () => dispatch({ type: "compaction-start" }));
	on("session_before_compact", () => dispatch({ type: "compaction-start" }));
	on("session.compacting", () => dispatch({ type: "compaction-start" }));
	on("auto_compaction_end", event => {
		const payload = record(event);
		dispatch({
			type: "compaction-end",
			error: Boolean(text(payload?.errorMessage)),
			aborted: boolean(payload?.aborted),
			willRetry: boolean(payload?.willRetry),
		});
	});
	on("session_compact", () => dispatch({ type: "compaction-end" }));
	on("agent_end", (event, ctx) => {
		const outcome = assistantOutcome(event);
		if (outcome.cancelled) dispatch({ type: "cancel" });
		dispatch({ type: "agent-end", pendingMessages: safeContextPending(ctx), isError: outcome.error });
	});

	const cleanupUi = (): void => {
		if (!workspaceArgs) return;
		enqueue(["clear-status", MAIN_STATUS_KEY, ...workspaceArgs], true);
		enqueue(["clear-progress", ...workspaceArgs], true);
		for (const key of ownedAgentKeys) enqueue(["clear-status", key, ...workspaceArgs], true);
		ownedAgentKeys.clear();
	};

	on("session_shutdown", async () => {
		dispatch({ type: "shutdown" });
		cleanupUi();
		disposed = true;
		await commandTail;
	});

	const subscribe = (channel: string, handler: (payload: unknown) => void): void => {
		const unsubscribe = looseApi.events?.on(channel, handler);
		if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
	};

	subscribe("task:subagent:lifecycle", payload => {
		const parsed = lifecyclePayload(payload);
		if (!parsed.id || !parsed.name || !parsed.status) return;
		dispatch({ type: "pending-messages", pending: safeContextPending(lastContext) });
		dispatch({
			type: "subagent-lifecycle",
			id: parsed.id,
			name: parsed.name,
			status: parsed.status,
			activity: parsed.activity,
		});
	});
	subscribe("task:subagent:progress", payload => {
		const parsed = progressPayload(payload);
		if (!parsed.id || !parsed.name) return;
		dispatch({ type: "pending-messages", pending: safeContextPending(lastContext) });
		dispatch({
			type: "subagent-progress",
			id: parsed.id,
			name: parsed.name,
			status: parsed.status,
			activity: parsed.activity,
		});
	});

	return async () => {
		if (disposed) {
			await commandTail;
			return;
		}
		for (const unsubscribe of unsubscribers.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// Extension teardown must not disturb OMP.
			}
		}
		cleanupUi();
		disposed = true;
		await commandTail;
	};
}
