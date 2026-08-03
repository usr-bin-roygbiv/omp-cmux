import { describe, expect, test } from "bun:test";

import { registerKvmTools, type KvmRunOptions, type KvmCommandResult } from "../plugins/cmux/src/kvm.ts";
import {
	KvmCaptureSchema,
	KvmDeviceSchema,
	KvmInputSchema,
	KvmInventorySchema,
	KvmRemoteMacSchema,
	KvmStorageSchema,
} from "../plugins/cmux/src/kvm-schemas.ts";

type ToolDefinition = {
	name: string;
	description: string;
	approval?: "read" | "write";
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
};

type RunCall = { argv: string[]; options: KvmRunOptions };

function commandResult(overrides: Partial<KvmCommandResult> = {}): KvmCommandResult {
	return {
		ok: true,
		exitCode: 0,
		signal: null,
		stdout: '{"ok":true}',
		stderr: "",
		timedOut: false,
		aborted: false,
		truncated: { stdout: false, stderr: false },
		...overrides,
	};
}

function harness(env: NodeJS.ProcessEnv = {
	PATH: "/tools",
	CMUX_WORKSPACE_ID: "workspace-1",
	CMUX_SURFACE_ID: "surface-1",
	KVM_FLEET_BINARY: "/tools/kvm-zacbook",
	SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock",
}) {
	const tools = new Map<string, ToolDefinition>();
	const calls: RunCall[] = [];
	const run = async (argv: readonly string[], options: KvmRunOptions = {}) => {
		calls.push({ argv: [...argv], options });
		return commandResult();
	};
	registerKvmTools({ registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as never, { run, env });
	return { tools, calls };
}

async function execute(subject: ReturnType<typeof harness>, name: string, params: Record<string, unknown>, signal?: AbortSignal) {
	const tool = subject.tools.get(name);
	if (!tool) throw new Error(`missing tool: ${name}`);
	return tool.execute("call-1", params, signal);
}

describe("fleet-wide KVM tools", () => {
	test("registers for a cmux root candidate and fails execution until the route is captured", async () => {
		const active = harness();
		expect([...active.tools.keys()]).toEqual([
			"kvm_inventory",
			"kvm_device",
			"kvm_capture",
			"kvm_input",
			"kvm_storage",
			"kvm_remote_mac",
		]);
		expect(active.tools.get("kvm_inventory")?.approval).toBe("read");
		expect(active.tools.get("kvm_device")?.approval).toBe("write");
		expect(active.tools.get("kvm_capture")?.approval).toBe("read");
		expect(active.tools.get("kvm_input")?.approval).toBe("write");
		expect(active.tools.get("kvm_storage")?.approval).toBe("write");
		expect(active.tools.get("kvm_remote_mac")?.approval).toBe("write");
		expect(harness({ PATH: "/tools" }).tools.size).toBe(0);
		expect(harness({ PATH: "/tools", CMUX_WORKSPACE_ID: "workspace-1" }).tools.size).toBe(0);
		expect(harness({ PATH: "/tools", CMUX_WORKSPACE_ID: "workspace-1", CMUX_TUI_SURFACE_ID: "2" }).tools.size).toBe(0);

		const unresolvedTui = harness({ PATH: "/tools", CMUX_TUI_SOCKET: "/tmp/cmux.sock" });
		expect(unresolvedTui.tools.size).toBe(6);
		const unresolvedResult = await execute(unresolvedTui, "kvm_inventory", {});
		expect(unresolvedResult.isError).toBe(true);
		expect(unresolvedResult.content[0]?.text).toMatch(/captured root cmux workspace and surface/i);
		expect(unresolvedTui.calls).toHaveLength(0);

		const mixedTui = harness({
			PATH: "/tools",
			CMUX_TUI_SOCKET: "/tmp/cmux.sock",
			CMUX_TUI_WORKSPACE_ID: "1",
			CMUX_SURFACE_ID: "surface-1",
		});
		expect(mixedTui.tools.size).toBe(6);
		expect((await execute(mixedTui, "kvm_inventory", {})).isError).toBe(true);
		expect(mixedTui.calls).toHaveLength(0);

		expect(harness({
			PATH: "/tools",
			CMUX_TUI_SOCKET: "/tmp/cmux.sock",
			CMUX_TUI_WORKSPACE_ID: "1",
			CMUX_TUI_SURFACE_ID: "2",
		}).tools.size).toBe(6);
	});

	test("publishes dependency-free strict schemas", () => {
		for (const schema of [KvmInventorySchema, KvmDeviceSchema, KvmCaptureSchema, KvmInputSchema, KvmStorageSchema, KvmRemoteMacSchema]) {
			const plain = JSON.parse(JSON.stringify(schema));
			expect(plain.type).toBe("object");
			expect(plain.additionalProperties).toBe(false);
		}
		expect(JSON.stringify(KvmDeviceSchema)).toContain("wake");
		expect(JSON.stringify(KvmInputSchema)).toContain("double-click");
		expect(JSON.stringify(KvmStorageSchema)).toContain("mount-url");
		expect(JSON.stringify(KvmRemoteMacSchema)).toContain("jxa");
	});

	test("translates typed operations into exact argv without a shell", async () => {
		const subject = harness();
		const controller = new AbortController();
		await execute(subject, "kvm_inventory", {}, controller.signal);
		await execute(subject, "kvm_device", { target: "linkedin-mac", action: "video" });
		await execute(subject, "kvm_capture", { target: "zacs-mbp-1", output: "/tmp/proof.png" });
		await execute(subject, "kvm_input", { target: "zacs-mbp-1", action: "text", text: "hello; still one arg" });
		await execute(subject, "kvm_input", { target: "zacs-mbp-1", action: "combo", keys: ["cmd", "shift", "g"] });
		await execute(subject, "kvm_storage", { target: "zacs-mbp-1", action: "mount-url", value: "https://example.test/test.iso" });
		await execute(subject, "kvm_remote_mac", {
			target: "zacs-mbp-2",
			action: "jxa",
			script: "function run(argv) { return JSON.stringify(argv); }",
			argument: '{"action":"status"}',
		});

		expect(subject.calls.map((call) => call.argv)).toEqual([
			["inventory", "--json"],
			["device", "linkedin-mac", "video"],
			["capture", "zacs-mbp-1", "--output", "/tmp/proof.png"],
			["input", "zacs-mbp-1", "text", "hello; still one arg"],
			["input", "zacs-mbp-1", "combo", "cmd", "shift", "g"],
			["storage", "zacs-mbp-1", "mount-url", "https://example.test/test.iso"],
			["mac", "zacs-mbp-2", "jxa", "--arg", '{"action":"status"}'],
		]);
		expect(subject.calls[0]?.options).toMatchObject({ binary: "/tools/kvm-zacbook", signal: controller.signal });
		expect(subject.calls[0]?.options.environmentProfile).toBe("kvm");
		expect(subject.calls.at(-1)?.options.stdin).toContain("function run");
	});

	test("fails closed on incomplete action fields before execution", async () => {
		const subject = harness();
		const cases = [
			["kvm_device", { target: "zacs-mbp-1", action: "wake" }],
			["kvm_capture", { target: "zacs-mbp-1", output: "relative.png" }],
			["kvm_input", { target: "zacs-mbp-1", action: "text" }],
			["kvm_input", { target: "zacs-mbp-1", action: "click", x: 1 }],
			["kvm_storage", { target: "zacs-mbp-1", action: "mount-local" }],
			["kvm_remote_mac", { target: "zacs-mbp-2", action: "jxa" }],
		] as const;
		for (const [name, params] of cases) {
			const result = await execute(subject, name, params);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("Invalid KVM tool input");
		}
		expect(subject.calls).toHaveLength(0);
	});

	test("documents LinkedIn safety and alternate-Mac visual control", () => {
		const subject = harness();
		const descriptions = [...subject.tools.values()].map((tool) => tool.description).join("\n");
		expect(descriptions).toContain("zacs-mbp-1");
		expect(descriptions).toContain("LinkedIn");
		expect(descriptions).toMatch(/exact user approval/i);
		expect(descriptions).toMatch(/remote Mac/i);
		expect(descriptions).toMatch(/never local zacbook input/i);
	});
});
