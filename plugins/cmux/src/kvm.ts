import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	runCmux,
	type CmuxCommandResult,
	type CmuxRunOptions,
} from "./cmux.ts";
import {
	KvmCaptureSchema,
	KvmDeviceSchema,
	KvmInputSchema,
	KvmInventorySchema,
	KvmRemoteMacSchema,
	KvmStorageSchema,
	type KvmCaptureInput,
	type KvmDeviceInput,
	type KvmInputInput,
	type KvmInventoryInput,
	type KvmRemoteMacInput,
	type KvmStorageInput,
} from "./kvm-schemas.ts";

export type KvmRunOptions = CmuxRunOptions;
export type KvmCommandResult = CmuxCommandResult;

type Runner = typeof runCmux;

type KvmToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: {
		operation: string;
		result?: KvmCommandResult;
		json?: unknown;
		validationError?: string;
	};
	isError: boolean;
};

type LocalToolDefinition<TInput> = {
	name: string;
	label: string;
	description: string;
	approval: "read" | "write";
	parameters: unknown;
	execute(id: string, params: TInput, signal: AbortSignal | undefined): Promise<KvmToolResult>;
};

function registerTool<TInput>(api: ExtensionAPI, definition: LocalToolDefinition<TInput>): void {
	api.registerTool(definition as never);
}

function required(value: string | undefined, name: string): string {
	if (value === undefined || value.trim() === "") throw new TypeError(`${name} is required for this action`);
	if (value.includes("\0")) throw new TypeError(`${name} must not contain NUL bytes`);
	return value;
}

function integer(value: number | undefined, name: string): number {
	if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is required for this action`);
	return value as number;
}

function failureResult(message: string): KvmToolResult {
	return {
		content: [{ type: "text", text: `Invalid KVM tool input: ${message}` }],
		details: { operation: "validation", validationError: message },
		isError: true,
	};
}

function resultText(result: KvmCommandResult): string {
	const primary = result.ok ? result.stdout.trim() : (result.stderr.trim() || result.stdout.trim());
	let text = primary || (result.ok ? "KVM command completed successfully." : result.error?.message || "KVM command failed.");
	if (result.truncated.stdout || result.truncated.stderr) text += "\n[KVM output truncated at the configured byte limit]";
	return text;
}

function hasRegistrationRoute(env: NodeJS.ProcessEnv): boolean {
	if (env.CMUX_TUI_SOCKET?.trim()) return true;
	return Boolean(env.CMUX_WORKSPACE_ID?.trim() && env.CMUX_SURFACE_ID?.trim());
}

function hasCapturedCmuxRoute(env: NodeJS.ProcessEnv): boolean {
	if (env.CMUX_TUI_SOCKET?.trim()) {
		return Boolean(
			env.CMUX_TUI_WORKSPACE_ID?.trim().match(/^[1-9][0-9]*$/)
			&& env.CMUX_TUI_SURFACE_ID?.trim().match(/^[1-9][0-9]*$/),
		);
	}
	return Boolean(env.CMUX_WORKSPACE_ID?.trim() && env.CMUX_SURFACE_ID?.trim());
}

async function executeCommand(
	operation: string,
	argv: string[],
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	runner: Runner,
	env: NodeJS.ProcessEnv,
	stdin?: string,
): Promise<KvmToolResult> {
	if (!hasCapturedCmuxRoute(env)) return failureResult("captured root cmux workspace and surface are unavailable");
	const result = await runner(argv, {
		binary: env.KVM_FLEET_BINARY?.trim() || "kvm-fleet",
		env,
		environmentProfile: "kvm",
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(signal === undefined ? {} : { signal }),
		...(stdin === undefined ? {} : { stdin }),
	});
	const details: KvmToolResult["details"] = { operation, result };
	if (result.ok && result.stdout.trim()) {
		try {
			details.json = JSON.parse(result.stdout);
		} catch {
			// Text output remains valid for legacy controller operations.
		}
	}
	return { content: [{ type: "text", text: resultText(result) }], details, isError: !result.ok };
}

function deviceArgv(params: KvmDeviceInput): string[] {
	if (params.action === "check") return ["check", required(params.target, "target")];
	const argv = ["device", required(params.target, "target"), params.action];
	if (params.action === "wake") argv.push("--mac", required(params.mac, "mac"));
	return argv;
}

function inputArgv(params: KvmInputInput): string[] {
	const argv = ["input", required(params.target, "target"), params.action];
	switch (params.action) {
		case "key":
			argv.push(required(params.key, "key"));
			break;
		case "combo":
			if (!params.keys || params.keys.length < 2) throw new TypeError("keys requires at least two entries for combo");
			argv.push(...params.keys.map((key, index) => required(key, `keys[${index}]`)));
			break;
		case "text":
			argv.push(required(params.text, "text"));
			break;
		case "mouse-move":
		case "double-click":
			argv.push(String(integer(params.x, "x")), String(integer(params.y, "y")));
			break;
		case "click":
			argv.push(String(integer(params.x, "x")), String(integer(params.y, "y")));
			if (params.button !== undefined) argv.push("--button", params.button);
			break;
		case "scroll":
			argv.push(String(integer(params.delta, "delta")));
			break;
	}
	return argv;
}

function storageArgv(params: KvmStorageInput): string[] {
	const argv = ["storage", required(params.target, "target"), params.action];
	if (params.action === "mount-local" || params.action === "mount-url") argv.push(required(params.value, "value"));
	return argv;
}

/** Register root/UI-only fleet KVM and remote-Mac tools beside the cmux tools. */
export function registerKvmTools(api: ExtensionAPI, options: { run?: Runner; env?: NodeJS.ProcessEnv } = {}): void {
	const env = options.env ?? process.env;
	if (!hasRegistrationRoute(env)) return;
	const runner = options.run ?? runCmux;

	registerTool(api, {
		name: "kvm_inventory",
		label: "KVM Inventory",
		description: "List the Git-backed remote-machine and JetKVM inventory. remote-mac-1 is the designated 16 GiB M2 Pro remote-target machine; alternate remote Macs are explicit test targets. This never controls local local-mac input.",
		approval: "read",
		parameters: KvmInventorySchema,
		async execute(_id, params: KvmInventoryInput, signal) {
			return executeCommand("inventory", ["inventory", "--json"], params.timeout_ms, signal, runner, env);
		},
	});

	registerTool(api, {
		name: "kvm_device",
		label: "KVM Device",
		description: "Check, identify, inspect video, ping, or wake a configured JetKVM-attached remote machine. Wake is remote state mutation and never local local-mac input.",
		approval: "write",
		parameters: KvmDeviceSchema,
		async execute(_id, params: KvmDeviceInput, signal) {
			try {
				return await executeCommand(`device:${params.action}`, deviceArgv(params), params.timeout_ms, signal, runner, env);
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid device action");
			}
		},
	});

	registerTool(api, {
		name: "kvm_capture",
		label: "KVM Capture",
		description: "Capture the exact JetKVM video frame from a remote machine to an absolute path on local-mac for visual confirmation, including remote-target confirmation on remote-mac-1.",
		approval: "read",
		parameters: KvmCaptureSchema,
		async execute(_id, params: KvmCaptureInput, signal) {
			try {
				if (!required(params.output, "output").startsWith("/")) throw new TypeError("output must be an absolute local-mac path");
				return await executeCommand("capture", ["capture", required(params.target, "target"), "--output", params.output], params.timeout_ms, signal, runner, env);
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid capture action");
			}
		},
	});

	registerTool(api, {
		name: "kvm_input",
		label: "KVM Input",
		description: "Send bounded keyboard, text, mouse, click, or scroll HID input to an exact remote JetKVM target. Never targets local local-mac input; any remote-target mutation still requires exact user approval immediately before execution.",
		approval: "write",
		parameters: KvmInputSchema,
		async execute(_id, params: KvmInputInput, signal) {
			try {
				return await executeCommand(`input:${params.action}`, inputArgv(params), params.timeout_ms, signal, runner, env);
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid input action");
			}
		},
	});

	registerTool(api, {
		name: "kvm_storage",
		label: "KVM Storage",
		description: "List, inspect, mount, or unmount virtual media on an exact remote JetKVM target. This never controls local local-mac input.",
		approval: "write",
		parameters: KvmStorageSchema,
		async execute(_id, params: KvmStorageInput, signal) {
			try {
				return await executeCommand(`storage:${params.action}`, storageArgv(params), params.timeout_ms, signal, runner, env);
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid storage action");
			}
		},
	});

	registerTool(api, {
		name: "kvm_remote_mac",
		label: "Remote Mac",
		description: "Inspect an exact remote Mac or run bounded JXA through osascript with the script on stdin. Use remote-mac-1 for remote-target and remote-mac-2/3 for non-remote-target tests. Never controls local local-mac input; external communication requires exact user approval immediately before execution.",
		approval: "write",
		parameters: KvmRemoteMacSchema,
		async execute(_id, params: KvmRemoteMacInput, signal) {
			try {
				const argv = ["mac", required(params.target, "target"), params.action];
				let stdin: string | undefined;
				if (params.action === "jxa") {
					stdin = required(params.script, "script");
					argv.push("--arg", params.argument ?? "{}");
				}
				return await executeCommand(`remote-mac:${params.action}`, argv, params.timeout_ms, signal, runner, env, stdin);
			} catch (error) {
				return failureResult(error instanceof Error ? error.message : "invalid remote Mac action");
			}
		},
	});
}
