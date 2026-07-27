export const LIFECYCLE_STATUSES = [
	"idle",
	"working",
	"thinking",
	"tool",
	"needs-input",
	"retrying",
	"compacting",
	"waiting",
	"done",
	"error",
	"stopped",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export type SubagentStatus = "queued" | "running" | "idle" | "parked" | "completed" | "failed";

export interface SubagentSnapshot {
	id: string;
	name: string;
	status: SubagentStatus;
	activity?: string;
}

export interface TodoItemSnapshot {
	content: string;
	status: string;
}

export interface TodoPhaseSnapshot {
	name: string;
	tasks: TodoItemSnapshot[];
}

export interface TodoProgressSnapshot {
	completed: number;
	total: number;
	currentPhase?: string;
	currentItem?: string;
}

export interface LifecycleSnapshot {
	status: LifecycleStatus;
	statusText: string;
	activeTool?: string;
	pendingMessages: boolean;
	turnEnded: boolean;
	completionNotified: boolean;
	todo?: TodoProgressSnapshot;
	subagents: SubagentSnapshot[];
}

export type LifecycleEffect =
	| { type: "status"; status: LifecycleStatus; text: string; toolName?: string }
	| { type: "todo"; progress?: TodoProgressSnapshot }
	| { type: "subagent"; agent: SubagentSnapshot }
	| { type: "subagent-remove"; id: string; name: string; status: "completed" | "failed" }
	| { type: "notify"; kind: "decision" | "complete"; title: string; body: string };

export type LifecycleAction =
	| { type: "session-start" }
	| { type: "agent-start" }
	| { type: "turn-start" }
	| { type: "message-start"; role?: string }
	| { type: "message-end"; role?: string; isError?: boolean }
	| { type: "tool-start"; id: string; name: string }
	| { type: "tool-end"; id: string; isError?: boolean; cancelled?: boolean }
	| { type: "retry-start"; attempt?: number; maxAttempts?: number }
	| { type: "retry-end"; success: boolean; finalError?: string }
	| { type: "compaction-start" }
	| { type: "compaction-end"; error?: boolean; aborted?: boolean; willRetry?: boolean }
	| { type: "pending-messages"; pending: boolean }
	| { type: "agent-end"; pendingMessages: boolean; willContinue?: boolean; isError?: boolean }
	| { type: "session-stop"; outcome: "completion" | "input" | "blocked" | "error" | "suppress" }
	| { type: "cancel" }
	| { type: "error" }
	| { type: "shutdown" }
	| { type: "todo-result"; phases: TodoPhaseSnapshot[] }
	| {
			type: "subagent-lifecycle";
			id: string;
			name: string;
			status: string;
			activity?: string;
		}
	| {
			type: "subagent-progress";
			id: string;
			name: string;
			status?: string;
			activity?: string;
		};

interface ToolActivity {
	name: string;
	order: number;
}

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "failed"]);

function isTerminalSubagentStatus(status: SubagentStatus): status is "completed" | "failed" {
	return TERMINAL_SUBAGENT_STATUSES.has(status);
}

function normalizeLine(value: string | undefined, maxLength = 120): string | undefined {
	if (!value) return undefined;
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

export function parseTodoProgress(phases: unknown): TodoProgressSnapshot | undefined {
	if (!Array.isArray(phases)) return undefined;

	let completed = 0;
	let total = 0;
	let firstOpen: { phase: string; item: string } | undefined;
	let inProgress: { phase: string; item: string } | undefined;

	for (const rawPhase of phases) {
		if (!rawPhase || typeof rawPhase !== "object") continue;
		const phase = rawPhase as { name?: unknown; tasks?: unknown };
		if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;
		for (const rawTask of phase.tasks) {
			if (!rawTask || typeof rawTask !== "object") continue;
			const task = rawTask as { content?: unknown; status?: unknown };
			if (typeof task.content !== "string" || typeof task.status !== "string") continue;
			total += 1;
			if (task.status === "completed") completed += 1;
			if (!firstOpen && (task.status === "pending" || task.status === "in_progress")) {
				firstOpen = { phase: phase.name, item: task.content };
			}
			if (!inProgress && task.status === "in_progress") {
				inProgress = { phase: phase.name, item: task.content };
			}
		}
	}

	if (total === 0) return { completed: 0, total: 0 };
	const current = inProgress ?? firstOpen;
	return {
		completed,
		total,
		currentPhase: current?.phase,
		currentItem: current?.item,
	};
}

function mapSubagentStatus(status: string | undefined): SubagentStatus | undefined {
	switch (status) {
		case "pending":
		case "queued":
			return "queued";
		case "started":
		case "active":
		case "running":
			return "running";
		case "idle":
			return "idle";
		case "parked":
			return "parked";
		case "completed":
			return "completed";
		case "failed":
		case "aborted":
		case "cancelled":
		case "canceled":
			return "failed";
		default:
			return undefined;
	}
}

export class LifecycleStateMachine {
	#status: LifecycleStatus = "idle";
	#statusText = "Idle";
	#agentRunning = false;
	#thinking = false;
	#turnEnded = false;
	#pendingMessages = false;
	#completionNotified = false;
	#shutdown = false;
	#error = false;
	#cancelled = false;
	#compacting = false;
	#retrying = false;
	#retryLabel: string | undefined;
	#toolOrder = 0;
	#tools = new Map<string, ToolActivity>();
	#needsInput = new Set<string>();
	#settledInput = false;
	#decisionNotified = new Set<string>();
	#subagents = new Map<string, SubagentSnapshot>();
	#terminalSubagents = new Set<string>();
	#todo: TodoProgressSnapshot | undefined;

	get snapshot(): LifecycleSnapshot {
		return {
			status: this.#status,
			statusText: this.#statusText,
			activeTool: this.#latestTool()?.name,
			pendingMessages: this.#pendingMessages,
			turnEnded: this.#turnEnded,
			completionNotified: this.#completionNotified,
			todo: this.#todo ? { ...this.#todo } : undefined,
			subagents: [...this.#subagents.values()].map(agent => ({ ...agent })),
		};
	}

	dispatch(action: LifecycleAction): LifecycleEffect[] {
		const effects: LifecycleEffect[] = [];
		const previousStatus = this.#status;
		const previousText = this.#statusText;
		const previousTool = this.#latestTool()?.name;

		switch (action.type) {
			case "session-start":
				this.#reset();
				break;
			case "agent-start":
				if (this.#shutdown) break;
				this.#agentRunning = true;
				this.#thinking = false;
				this.#turnEnded = false;
				this.#completionNotified = false;
				this.#pendingMessages = false;
				this.#error = false;
				this.#cancelled = false;
				this.#settledInput = false;
				break;
			case "turn-start":
				if (this.#shutdown) break;
				this.#agentRunning = true;
				this.#thinking = true;
				this.#turnEnded = false;
				this.#error = false;
				break;
			case "message-start":
				if (this.#shutdown) break;
				this.#agentRunning = true;
				this.#turnEnded = false;
				this.#thinking = action.role === "assistant";
				break;
			case "message-end":
				if (this.#shutdown) break;
				if (action.isError) this.#error = true;
				if (action.role === "assistant") this.#thinking = false;
				break;
			case "tool-start":
				if (this.#shutdown) break;
				this.#agentRunning = true;
				this.#turnEnded = false;
				this.#thinking = false;
				this.#error = false;
				this.#tools.set(action.id, { name: action.name, order: ++this.#toolOrder });
				if (action.name === "ask" || action.name.endsWith(".ask")) {
					this.#needsInput.add(action.id);
					if (!this.#decisionNotified.has(action.id)) {
						this.#decisionNotified.add(action.id);
						effects.push({
							type: "notify",
							kind: "decision",
							title: "OMP needs your decision",
							body: "An explicit answer is required to continue.",
						});
					}
				}
				break;
			case "tool-end":
				if (!this.#tools.has(action.id)) break;
				this.#tools.delete(action.id);
				this.#needsInput.delete(action.id);
				if (action.cancelled) this.#cancelled = true;
				else if (action.isError) this.#error = true;
				else this.#thinking = this.#agentRunning;
				break;
			case "retry-start":
				if (this.#shutdown) break;
				this.#retrying = true;
				this.#error = false;
				this.#retryLabel =
					action.attempt !== undefined && action.maxAttempts !== undefined
						? `Retrying ${action.attempt}/${action.maxAttempts}`
						: "Retrying";
				break;
			case "retry-end":
				if (!this.#retrying) break;
				this.#retrying = false;
				this.#retryLabel = undefined;
				if (!action.success && action.finalError) this.#error = true;
				else if (action.success) this.#thinking = this.#agentRunning;
				break;
			case "compaction-start":
				if (this.#shutdown) break;
				this.#compacting = true;
				this.#error = false;
				break;
			case "compaction-end":
				if (!this.#compacting) break;
				this.#compacting = false;
				if (action.error && !action.willRetry) this.#error = true;
				else if (!action.aborted) this.#thinking = this.#agentRunning;
				break;
			case "pending-messages":
				this.#pendingMessages = action.pending;
				break;
			case "agent-end":
				if (this.#shutdown) break;
				this.#agentRunning = false;
				this.#thinking = false;
				this.#tools.clear();
				this.#needsInput.clear();
				this.#pendingMessages = action.pendingMessages;
				this.#turnEnded = !action.willContinue;
				if (action.isError) this.#error = true;
				break;
			case "session-stop":
				if (this.#shutdown) break;
				this.#agentRunning = false;
				this.#thinking = false;
				this.#turnEnded = true;
				this.#pendingMessages = false;
				this.#compacting = false;
				this.#retrying = false;
				this.#retryLabel = undefined;
				this.#tools.clear();
				this.#needsInput.clear();
				this.#settledInput = action.outcome === "input" || action.outcome === "blocked";
				this.#error = action.outcome === "error";
				this.#cancelled = action.outcome === "suppress";
				break;
			case "cancel":
				if (this.#shutdown) break;
				this.#cancelled = true;
				this.#agentRunning = false;
				this.#thinking = false;
				this.#tools.clear();
				this.#needsInput.clear();
				break;
			case "error":
				if (!this.#shutdown) this.#error = true;
				break;
			case "shutdown":
				this.#shutdown = true;
				this.#agentRunning = false;
				this.#thinking = false;
				this.#tools.clear();
				this.#needsInput.clear();
				break;
			case "todo-result": {
				const next = parseTodoProgress(action.phases);
				if (!sameTodo(this.#todo, next)) {
					this.#todo = next;
					effects.push({ type: "todo", progress: next ? { ...next } : undefined });
				}
				break;
			}
			case "subagent-lifecycle": {
				const status = mapSubagentStatus(action.status);
				if (!status) break;
				if (status === "running") this.#terminalSubagents.delete(action.id);
				const existing = this.#subagents.get(action.id);
				const name = normalizeLine(action.name, 80) ?? existing?.name ?? "Subagent";
				const activity = normalizeLine(action.activity) ?? existing?.activity;
				const agent = { id: action.id, name, status, activity } satisfies SubagentSnapshot;
				this.#subagents.set(action.id, agent);
				if (isTerminalSubagentStatus(status)) {
					this.#terminalSubagents.add(action.id);
					effects.push({ type: "subagent-remove", id: action.id, name, status });
				} else {
					effects.push({ type: "subagent", agent: { ...agent } });
				}
				break;
			}
			case "subagent-progress": {
				if (this.#terminalSubagents.has(action.id)) break;
				const existing = this.#subagents.get(action.id);
				const status = mapSubagentStatus(action.status) ?? existing?.status ?? "running";
				const name = normalizeLine(action.name, 80) ?? existing?.name ?? "Subagent";
				const activity = normalizeLine(action.activity) ?? existing?.activity;
				const agent = { id: action.id, name, status, activity } satisfies SubagentSnapshot;
				this.#subagents.set(action.id, agent);
				if (isTerminalSubagentStatus(status)) {
					this.#terminalSubagents.add(action.id);
					effects.push({ type: "subagent-remove", id: action.id, name, status });
				} else {
					effects.push({ type: "subagent", agent: { ...agent } });
				}
				break;
			}
		}

		this.#deriveStatus();
		const nextTool = this.#latestTool()?.name;
		if (
			action.type === "session-start" ||
			previousStatus !== this.#status ||
			previousText !== this.#statusText ||
			previousTool !== nextTool
		) {
			effects.push({ type: "status", status: this.#status, text: this.#statusText, toolName: nextTool });
		}
		this.#maybeComplete(effects);
		return effects;
	}

	#reset(): void {
		this.#status = "idle";
		this.#statusText = "Idle";
		this.#agentRunning = false;
		this.#thinking = false;
		this.#turnEnded = false;
		this.#pendingMessages = false;
		this.#completionNotified = false;
		this.#shutdown = false;
		this.#error = false;
		this.#cancelled = false;
		this.#compacting = false;
		this.#retrying = false;
		this.#retryLabel = undefined;
		this.#tools.clear();
		this.#needsInput.clear();
		this.#settledInput = false;
		this.#decisionNotified.clear();
		this.#subagents.clear();
		this.#terminalSubagents.clear();
		this.#todo = undefined;
	}

	#liveSubagentCount(): number {
		let count = 0;
		for (const agent of this.#subagents.values()) {
			if (!TERMINAL_SUBAGENT_STATUSES.has(agent.status)) count += 1;
		}
		return count;
	}

	#latestTool(): ToolActivity | undefined {
		let latest: ToolActivity | undefined;
		for (const tool of this.#tools.values()) {
			if (!latest || tool.order > latest.order) latest = tool;
		}
		return latest;
	}

	#deriveStatus(): void {
		if (this.#shutdown) {
			this.#status = "stopped";
			this.#statusText = "Stopped";
			return;
		}
		if (this.#cancelled) {
			this.#status = "stopped";
			this.#statusText = "Stopped";
			return;
		}
		if (this.#error) {
			this.#status = "error";
			this.#statusText = "Error";
			return;
		}
		if (this.#settledInput || this.#needsInput.size > 0) {
			this.#status = "needs-input";
			this.#statusText = "Needs input";
			return;
		}
		if (this.#compacting) {
			this.#status = "compacting";
			this.#statusText = "Compacting";
			return;
		}
		if (this.#retrying) {
			this.#status = "retrying";
			this.#statusText = this.#retryLabel ?? "Retrying";
			return;
		}
		const tool = this.#latestTool();
		if (tool) {
			this.#status = "tool";
			this.#statusText = `Tool: ${tool.name}`;
			return;
		}
		if (this.#thinking) {
			this.#status = "thinking";
			this.#statusText = "Thinking";
			return;
		}
		if (this.#agentRunning) {
			this.#status = "working";
			this.#statusText = "Working";
			return;
		}
		if (this.#turnEnded) {
			const live = this.#liveSubagentCount();
			if (this.#pendingMessages || live > 0) {
				this.#status = "waiting";
				this.#statusText = live > 0 ? `Waiting for ${live} subagent${live === 1 ? "" : "s"}` : "Waiting for messages";
				return;
			}
			this.#status = "done";
			this.#statusText = "Done";
			return;
		}
		this.#status = "idle";
		this.#statusText = "Idle";
	}

	#maybeComplete(effects: LifecycleEffect[]): void {
		if (
			this.#completionNotified ||
			!this.#turnEnded ||
			this.#pendingMessages ||
			this.#liveSubagentCount() > 0 ||
			this.#shutdown ||
			this.#cancelled ||
			this.#error
		) {
			return;
		}
		this.#completionNotified = true;
		effects.push({
			type: "notify",
			kind: "complete",
			title: "OMP turn complete",
			body: "The turn finished with no pending messages or active subagents.",
		});
	}
}

function sameTodo(left: TodoProgressSnapshot | undefined, right: TodoProgressSnapshot | undefined): boolean {
	return (
		left?.completed === right?.completed &&
		left?.total === right?.total &&
		left?.currentPhase === right?.currentPhase &&
		left?.currentItem === right?.currentItem
	);
}
