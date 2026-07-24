import { describe, expect, test } from "bun:test";

import {
	LIFECYCLE_STATUSES,
	LifecycleStateMachine,
	parseTodoProgress,
	type LifecycleAction,
	type LifecycleEffect,
	type LifecycleStatus,
} from "../plugins/cmux/src/state.ts";

function statusAfter(actions: LifecycleAction[]): { status: LifecycleStatus; text: string; tool?: string } {
	const machine = new LifecycleStateMachine();
	for (const action of actions) machine.dispatch(action);
	return { status: machine.snapshot.status, text: machine.snapshot.statusText, tool: machine.snapshot.activeTool };
}

function notifications(effects: LifecycleEffect[], kind?: "decision" | "complete") {
	return effects.filter(
		(effect): effect is Extract<LifecycleEffect, { type: "notify" }> =>
			effect.type === "notify" && (kind === undefined || effect.kind === kind),
	);
}

describe("OMP lifecycle states", () => {
	test("covers the complete public lifecycle vocabulary with observable transitions", () => {
		const observed = new Map<LifecycleStatus, string>();
		const cases: LifecycleAction[][] = [
			[],
			[{ type: "agent-start" }],
			[{ type: "turn-start" }],
			[{ type: "agent-start" }, { type: "tool-start", id: "tool-1", name: "read" }],
			[{ type: "agent-start" }, { type: "tool-start", id: "ask-1", name: "ask" }],
			[{ type: "agent-start" }, { type: "retry-start", attempt: 2, maxAttempts: 4 }],
			[{ type: "agent-start" }, { type: "compaction-start" }],
			[{ type: "agent-end", pendingMessages: true }],
			[{ type: "agent-end", pendingMessages: false }],
			[{ type: "error" }],
			[{ type: "shutdown" }],
		];
		for (const actions of cases) {
			const current = statusAfter(actions);
			observed.set(current.status, current.text);
		}

		expect([...observed.keys()].sort()).toEqual([...LIFECYCLE_STATUSES].sort());
		expect(Object.fromEntries(observed)).toEqual({
			idle: "Idle",
			working: "Working",
			thinking: "Thinking",
			tool: "Tool: read",
			"needs-input": "Needs input",
			retrying: "Retrying 2/4",
			compacting: "Compacting",
			waiting: "Waiting for messages",
			done: "Done",
			error: "Error",
			stopped: "Stopped",
		});
	});

	test("reports the newest active tool by name and restores the preceding tool when it ends", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "agent-start" });
		machine.dispatch({ type: "tool-start", id: "older", name: "read" });
		expect(machine.snapshot).toMatchObject({ status: "tool", statusText: "Tool: read", activeTool: "read" });

		const newerEffects = machine.dispatch({ type: "tool-start", id: "newer", name: "cmux_rpc" });
		expect(machine.snapshot).toMatchObject({ status: "tool", statusText: "Tool: cmux_rpc", activeTool: "cmux_rpc" });
		expect(newerEffects).toContainEqual({ type: "status", status: "tool", text: "Tool: cmux_rpc", toolName: "cmux_rpc" });

		machine.dispatch({ type: "tool-end", id: "newer" });
		expect(machine.snapshot).toMatchObject({ status: "tool", statusText: "Tool: read", activeTool: "read" });
		machine.dispatch({ type: "tool-end", id: "older" });
		expect(machine.snapshot).toMatchObject({ status: "thinking", statusText: "Thinking" });
	});

	test("gives needs-input, errors, compaction, and retry precedence over ordinary activity", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "agent-start" });
		machine.dispatch({ type: "tool-start", id: "read-1", name: "read" });
		machine.dispatch({ type: "retry-start" });
		expect(machine.snapshot.status).toBe("retrying");
		machine.dispatch({ type: "compaction-start" });
		expect(machine.snapshot.status).toBe("compacting");
		machine.dispatch({ type: "tool-start", id: "ask-1", name: "ask" });
		expect(machine.snapshot.status).toBe("needs-input");
		machine.dispatch({ type: "error" });
		expect(machine.snapshot.status).toBe("error");
	});

	test("ignores stale end events and all post-shutdown activity", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "agent-start" });
		machine.dispatch({ type: "tool-end", id: "never-started", isError: true });
		expect(machine.snapshot.status).toBe("working");
		machine.dispatch({ type: "shutdown" });
		machine.dispatch({ type: "turn-start" });
		machine.dispatch({ type: "tool-start", id: "late", name: "write" });
		expect(machine.snapshot).toMatchObject({ status: "stopped", activeTool: undefined });
	});
});

describe("todo progress", () => {
	test("counts valid items and prefers the in-progress item over the first pending item", () => {
		const phases = [
			{
				name: "Prepare",
				tasks: [
					{ content: "Already complete", status: "completed" },
					{ content: "Waiting item", status: "pending" },
				],
			},
			{
				name: "Execute",
				tasks: [
					{ content: "Current item", status: "in_progress" },
					{ content: "Later item", status: "pending" },
				],
			},
		];
		expect(parseTodoProgress(phases)).toEqual({
			completed: 1,
			total: 4,
			currentPhase: "Execute",
			currentItem: "Current item",
		});
	});

	test("emits progress only when observable progress changes and tolerates malformed result entries", () => {
		const machine = new LifecycleStateMachine();
		const phases = [
			{ name: "Build", tasks: [{ content: "Implement", status: "in_progress" }, null, { status: "pending" }] },
			{ name: 42, tasks: [] },
		];
		const first = machine.dispatch({ type: "todo-result", phases: phases as never });
		expect(first).toContainEqual({
			type: "todo",
			progress: { completed: 0, total: 1, currentPhase: "Build", currentItem: "Implement" },
		});
		expect(machine.dispatch({ type: "todo-result", phases: phases as never })).toEqual([]);
	});
});

describe("subagent synchronization", () => {
	test("surfaces each active subagent by name, state, and current activity", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "subagent-lifecycle", id: "a", name: "Researcher", status: "queued" });
		machine.dispatch({ type: "subagent-lifecycle", id: "b", name: "Builder", status: "running", activity: "Editing tools" });
		machine.dispatch({ type: "subagent-progress", id: "a", name: "Researcher", status: "parked", activity: "Awaiting input" });

		expect(machine.snapshot.subagents).toEqual([
			{ id: "a", name: "Researcher", status: "parked", activity: "Awaiting input" },
			{ id: "b", name: "Builder", status: "running", activity: "Editing tools" },
		]);
	});

	test("maps terminal variants and suppresses progress that arrives after terminal lifecycle events", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "subagent-lifecycle", id: "agent-1", name: "Verifier", status: "running", activity: "Checking" });
		const terminal = machine.dispatch({ type: "subagent-lifecycle", id: "agent-1", name: "Verifier", status: "completed" });
		expect(terminal).toContainEqual({ type: "subagent-remove", id: "agent-1", name: "Verifier", status: "completed" });

		const late = machine.dispatch({
			type: "subagent-progress",
			id: "agent-1",
			name: "Verifier",
			status: "running",
			activity: "stale late progress",
		});
		expect(late).toEqual([]);
		expect(machine.snapshot.subagents).toContainEqual({
			id: "agent-1",
			name: "Verifier",
			status: "completed",
			activity: "Checking",
		});

		const failed = machine.dispatch({ type: "subagent-lifecycle", id: "agent-2", name: "Builder", status: "cancelled" });
		expect(failed).toContainEqual({ type: "subagent-remove", id: "agent-2", name: "Builder", status: "failed" });
	});

	test("permits an explicit new running lifecycle event to reactivate a reused agent id", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "subagent-lifecycle", id: "agent-1", name: "Builder", status: "completed" });
		const restarted = machine.dispatch({ type: "subagent-lifecycle", id: "agent-1", name: "Builder", status: "running", activity: "Second task" });
		expect(restarted).toContainEqual({
			type: "subagent",
			agent: { id: "agent-1", name: "Builder", status: "running", activity: "Second task" },
		});
	});
});

describe("notification policy", () => {
	test("notifies for an explicit ask decision exactly once and for no other tool", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "agent-start" });
		const ordinary = machine.dispatch({ type: "tool-start", id: "read-1", name: "read" });
		expect(notifications(ordinary)).toEqual([]);

		const firstAsk = machine.dispatch({ type: "tool-start", id: "ask-1", name: "ask" });
		expect(notifications(firstAsk, "decision")).toHaveLength(1);
		machine.dispatch({ type: "tool-end", id: "ask-1" });
		const duplicateAskEvent = machine.dispatch({ type: "tool-start", id: "ask-1", name: "ask" });
		expect(notifications(duplicateAskEvent, "decision")).toEqual([]);

		const similarName = machine.dispatch({ type: "tool-start", id: "ask-2", name: "ask_user" });
		expect(notifications(similarName)).toEqual([]);
	});

	test("defers completion after agent-end until all subagents terminate and pending messages clear", () => {
		const machine = new LifecycleStateMachine();
		machine.dispatch({ type: "agent-start" });
		machine.dispatch({ type: "subagent-lifecycle", id: "a", name: "Researcher", status: "running" });
		machine.dispatch({ type: "subagent-lifecycle", id: "b", name: "Builder", status: "queued" });
		const ended = machine.dispatch({ type: "agent-end", pendingMessages: true });
		expect(machine.snapshot).toMatchObject({ status: "waiting", statusText: "Waiting for 2 subagents" });
		expect(notifications(ended, "complete")).toEqual([]);

		const firstTerminal = machine.dispatch({ type: "subagent-lifecycle", id: "a", name: "Researcher", status: "completed" });
		expect(machine.snapshot).toMatchObject({ status: "waiting", statusText: "Waiting for 1 subagent" });
		expect(notifications(firstTerminal, "complete")).toEqual([]);

		const messagesClearEarly = machine.dispatch({ type: "pending-messages", pending: false });
		expect(machine.snapshot.status).toBe("waiting");
		expect(notifications(messagesClearEarly, "complete")).toEqual([]);

		const finalTerminal = machine.dispatch({ type: "subagent-lifecycle", id: "b", name: "Builder", status: "completed" });
		expect(machine.snapshot).toMatchObject({ status: "done", completionNotified: true });
		expect(notifications(finalTerminal, "complete")).toHaveLength(1);

		const staleTerminal = machine.dispatch({ type: "subagent-lifecycle", id: "b", name: "Builder", status: "completed" });
		expect(notifications(staleTerminal, "complete")).toEqual([]);
	});

	test("does not emit completion notifications for errors, cancellation, shutdown, or continuing turns", () => {
		const scenarios: LifecycleAction[][] = [
			[{ type: "error" }, { type: "agent-end", pendingMessages: false, isError: true }],
			[{ type: "cancel" }, { type: "agent-end", pendingMessages: false }],
			[{ type: "shutdown" }, { type: "agent-end", pendingMessages: false }],
			[{ type: "agent-end", pendingMessages: false, willContinue: true }],
		];
		for (const actions of scenarios) {
			const machine = new LifecycleStateMachine();
			const effects = actions.flatMap(action => machine.dispatch(action));
			expect(notifications(effects, "complete")).toEqual([]);
		}
	});
});
