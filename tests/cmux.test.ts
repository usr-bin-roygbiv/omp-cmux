import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
	buildSafeEnvironment,
	exactSurfaceTarget,
	exactTargetArgs,
	exactWorkspaceTarget,
	parseCmuxJson,
	runCmux,
} from "../plugins/cmux/src/cmux.ts";

type SpawnObservation = {
	file?: string;
	args?: string[];
	options?: SpawnOptions;
	kills: NodeJS.Signals[];
	stdin: Buffer[];
};

type FakeOutcome = {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	errorCode?: string;
	autoClose?: boolean;
	closeOnKill?: boolean;
};

function fakeSpawner(observation: SpawnObservation, outcome: FakeOutcome = {}) {
	return ((file: string, args: readonly string[], options: SpawnOptions) => {
		observation.file = file;
		observation.args = [...args];
		observation.options = options;
		const child = new EventEmitter() as ChildProcess;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		const stdin = new PassThrough();
		stdin.on("data", chunk => observation.stdin.push(Buffer.from(chunk)));
		child.stdin = stdin;
		child.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
			observation.kills.push(signal);
			if (outcome.closeOnKill !== false) {
				queueMicrotask(() => child.emit("close", null, signal));
			}
			return true;
		}) as ChildProcess["kill"];
		queueMicrotask(() => {
			if (outcome.errorCode) {
				const error = Object.assign(new Error("spawn failed"), { code: outcome.errorCode });
				child.emit("error", error);
			}
			if (outcome.stdout) child.stdout!.emit("data", Buffer.from(outcome.stdout));
			if (outcome.stderr) child.stderr!.emit("data", Buffer.from(outcome.stderr));
			if (outcome.autoClose !== false) {
				child.emit("close", outcome.exitCode ?? 0, outcome.signal ?? null);
			}
		});
		return child;
	}) as typeof import("node:child_process").spawn;
}

function observation(): SpawnObservation {
	return { kills: [], stdin: [] };
}

describe("safe cmux process execution", () => {
	test("inherits only operational variables, passes socket credentials only to cmux, and disables legacy hooks", () => {
		const safe = buildSafeEnvironment(
			{
				PATH: "/tools",
				HOME: "/temporary-home",
				LANG: "C.UTF-8",
				CMUX_SOCKET_PATH: "/temporary/socket",
				CMUX_SOCKET_PASSWORD: "socket-secret",
				CMUX_WORKSPACE_ID: "workspace-1",
				CMUX_TUI_SOCKET: "/temporary/tui.sock",
				CMUX_TUI_SURFACE_ID: "17",
				CMUX_TUI_WORKSPACE_ID: "3",
				CMUX_MUX_SOCKET: "/temporary/mux.sock",
				AWS_SECRET_ACCESS_KEY: "must-not-leak",
				GITHUB_TOKEN: "must-not-leak",
				SSH_AUTH_SOCK: "/must/not/leak",
				NODE_OPTIONS: "--require=untrusted.js",
			},
			{ PATH: "/override", GITHUB_TOKEN: "still-must-not-leak" },
		);

		expect(safe).toEqual({
			PATH: "/override",
			HOME: "/temporary-home",
			LANG: "C.UTF-8",
			CMUX_SOCKET_PATH: "/temporary/socket",
			CMUX_SOCKET_PASSWORD: "socket-secret",
			CMUX_WORKSPACE_ID: "workspace-1",
			CMUX_TUI_SOCKET: "/temporary/tui.sock",
			CMUX_TUI_SURFACE_ID: "17",
			CMUX_TUI_WORKSPACE_ID: "3",
			CMUX_MUX_SOCKET: "/temporary/mux.sock",
			CMUX_OMP_HOOKS_DISABLED: "1",
		});
	});

	test("passes forwarded SSH and controller overrides only to the KVM profile", () => {
		const safe = buildSafeEnvironment(
			{
				PATH: "/tools",
				SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock",
				KVM_FLEET_BINARY: "/tools/kvm-fleet",
				JETKVM_TOOL_SSH_HOST: "local-mac",
				GITHUB_TOKEN: "must-not-leak",
			},
			{},
			true,
			"kvm",
		);

		expect(safe).toEqual({
			PATH: "/tools",
			SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock",
			KVM_FLEET_BINARY: "/tools/kvm-fleet",
			JETKVM_TOOL_SSH_HOST: "local-mac",
			CMUX_OMP_HOOKS_DISABLED: "1",
		});
	});

	test("spawns the selected executable directly and preserves hostile-looking values as single argv entries", async () => {
		const seen = observation();
		const hostile = "surface; printf should-not-run | $(also-not-run)";
		const result = await runCmux(["surface", "rename", "--surface", hostile], {
			binary: "cmux-test",
			env: { PATH: "/tools", CMUX_SOCKET_PASSWORD: "socket-secret", UNRELATED_SECRET: "no" },
			spawn: fakeSpawner(seen, { stdout: "renamed\n" }),
		});

		expect(result.ok).toBe(true);
		expect(seen.file).toBe("cmux-test");
		expect(seen.args).toEqual(["surface", "rename", "--surface", hostile]);
		expect(seen.options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"] });
		expect(seen.options?.env).not.toHaveProperty("UNRELATED_SECRET");
		expect(seen.options?.env).toMatchObject({
			CMUX_SOCKET_PASSWORD: "socket-secret",
			CMUX_OMP_HOOKS_DISABLED: "1",
		});
	});

	test("prefers the native GUI executable over a stale TUI override in a Darwin GUI session", async () => {
		const seen = observation();
		const result = await runCmux(["capabilities"], {
			env: {
				CMUX_OMP_BINARY: "/tmp/npm/cmux-tui",
				CMUX_WORKSPACE_ID: "workspace-gui",
				CMUX_SURFACE_ID: "surface-gui",
			},
			platform: "darwin",
			spawn: fakeSpawner(seen, { stdout: "{}" }),
		});

		expect(result.ok).toBe(true);
		expect(seen.file).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");
	});

	test("preserves the selected TUI executable when a TUI socket is present", async () => {
		const seen = observation();
		const result = await runCmux(["capabilities"], {
			env: {
				CMUX_OMP_BINARY: "cmux-tui-test",
				CMUX_WORKSPACE_ID: "workspace-gui",
				CMUX_SURFACE_ID: "surface-gui",
				CMUX_TUI_SOCKET: "/tmp/cmux-tui.sock",
			},
			platform: "darwin",
			spawn: fakeSpawner(seen, { stdout: "{}" }),
		});

		expect(result.ok).toBe(true);
		expect(seen.file).toBe("cmux-tui-test");
	});

	test("does not force the GUI executable when the injected GUI identity is incomplete", async () => {
		const seen = observation();
		await runCmux(["capabilities"], {
			env: { CMUX_OMP_BINARY: "configured-cmux", CMUX_WORKSPACE_ID: "workspace-only" },
			platform: "darwin",
			spawn: fakeSpawner(seen, { stdout: "{}" }),
		});

		expect(seen.file).toBe("configured-cmux");
	});

	test("bounds stdout and stderr independently and reports truncation", async () => {
		const seen = observation();
		const result = await runCmux(["capabilities"], {
			binary: "cmux-test",
			maxOutputBytes: 8,
			spawn: fakeSpawner(seen, { stdout: "1234567890", stderr: "abcdefghij" }),
		});

		expect(result).toMatchObject({
			ok: true,
			stdout: "12345678",
			stderr: "abcdefgh",
			truncated: { stdout: true, stderr: true },
		});
	});

	test("writes stdin without shell interpolation", async () => {
		const seen = observation();
		const payload = "line one\n$(not-a-command)\n";
		const result = await runCmux(["rpc", "safe.method"], {
			binary: "cmux-test",
			stdin: payload,
			spawn: fakeSpawner(seen),
		});

		expect(result.ok).toBe(true);
		expect(Buffer.concat(seen.stdin).toString()).toBe(payload);
	});

	test("rejects NUL argv before spawning", async () => {
		let spawned = false;
		const result = await runCmux(["rpc", "bad\0argument"], {
			spawn: ((..._args: unknown[]) => {
				spawned = true;
				throw new Error("must not spawn");
			}) as typeof import("node:child_process").spawn,
		});

		expect(spawned).toBe(false);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
	});

	test("returns a stable spawn error for synchronous process failures", async () => {
		const result = await runCmux(["capabilities"], {
			binary: "missing-cmux",
			spawn: (() => {
				throw Object.assign(new Error("sensitive operating-system detail"), { code: "ENOENT" });
			}) as typeof import("node:child_process").spawn,
		});

		expect(result).toMatchObject({
			ok: false,
			exitCode: null,
			error: { code: "SPAWN_ERROR", message: "failed to start cmux (ENOENT)" },
		});
		expect(JSON.stringify(result)).not.toContain("sensitive operating-system detail");
	});

	test("shapes asynchronous process errors without losing bounded output", async () => {
		const seen = observation();
		const result = await runCmux(["capabilities"], {
			binary: "cmux-test",
			spawn: fakeSpawner(seen, { errorCode: "EACCES", stderr: "denied", exitCode: null }),
		});

		expect(result).toMatchObject({
			ok: false,
			stderr: "denied",
			error: { code: "SPAWN_ERROR", message: "failed to start cmux (EACCES)" },
		});
	});

	test("terminates timed-out processes and distinguishes timeout from abort", async () => {
		const seen = observation();
		const result = await runCmux(["rpc", "slow.method"], {
			binary: "cmux-test",
			timeoutMs: 2,
			spawn: fakeSpawner(seen, { autoClose: false }),
		});

		// This fake deliberately does not close normally, but closes as soon as termination is observed.
		// The timeout boundary itself remains the runtime behavior under test.
		expect(seen.kills[0]).toBe("SIGTERM");
		expect(result).toMatchObject({ ok: false, timedOut: true, aborted: false, error: { code: "TIMEOUT" } });
	});

	test("does not spawn for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		let spawned = false;
		const result = await runCmux(["capabilities"], {
			signal: controller.signal,
			spawn: ((..._args: unknown[]) => {
				spawned = true;
				throw new Error("must not spawn");
			}) as typeof import("node:child_process").spawn,
		});

		expect(spawned).toBe(false);
		expect(result).toMatchObject({ ok: false, aborted: true, timedOut: false, error: { code: "ABORTED" } });
	});

	test("aborts a running process through its signal boundary", async () => {
		const controller = new AbortController();
		const seen = observation();
		const promise = runCmux(["rpc", "wait.method"], {
			binary: "cmux-test",
			timeoutMs: 5_000,
			signal: controller.signal,
			spawn: fakeSpawner(seen, { autoClose: false }),
		});
		controller.abort();
		const result = await promise;

		expect(seen.kills[0]).toBe("SIGTERM");
		expect(result).toMatchObject({ ok: false, timedOut: false, aborted: true, error: { code: "ABORTED" } });
	});
});

describe("exact cmux routing", () => {
	test("uses explicit workspace and surface identities over environment identities", () => {
		expect(
			exactSurfaceTarget(
				{ workspaceId: "explicit-workspace", surfaceId: "explicit-surface" },
				{ CMUX_WORKSPACE_ID: "environment-workspace", CMUX_SURFACE_ID: "environment-surface" },
			),
		).toEqual({ workspaceId: "explicit-workspace", surfaceId: "explicit-surface" });
		expect(
			exactTargetArgs(
				{ workspaceId: "explicit-workspace", surfaceId: "explicit-surface", windowId: "window-1" },
				"surface",
				{},
			),
		).toEqual(["--window", "window-1", "--workspace", "explicit-workspace", "--surface", "explicit-surface"]);
	});

	test("routes through injected workspace and surface identities when explicit identities are absent", () => {
		const env = { CMUX_WORKSPACE_ID: "workspace-from-env", CMUX_SURFACE_ID: "surface-from-env" };
		expect(exactWorkspaceTarget(undefined, env)).toBe("workspace-from-env");
		expect(exactTargetArgs({}, "surface", env)).toEqual([
			"--workspace",
			"workspace-from-env",
			"--surface",
			"surface-from-env",
		]);
	});

	test("fails closed instead of mutating whichever workspace or surface is focused", () => {
		expect(() => exactWorkspaceTarget(undefined, {})).toThrow(/workspace identity is required/i);
		expect(() => exactSurfaceTarget({}, { CMUX_WORKSPACE_ID: "workspace-only" })).toThrow(/surface identity is required/i);
		expect(() => exactTargetArgs({}, "surface", {})).toThrow();
	});
});

describe("cmux JSON output", () => {
	test("parses structured output and rejects empty or malformed output without echoing it", () => {
		expect(parseCmuxJson<{ methods: string[] }>(' {"methods":["workspace.list"]} ')).toEqual({ methods: ["workspace.list"] });
		expect(() => parseCmuxJson("  ")).toThrow("cmux returned empty JSON output");
		expect(() => parseCmuxJson("not-json-with-private-output")).toThrow("cmux returned invalid JSON output");
	});
});
