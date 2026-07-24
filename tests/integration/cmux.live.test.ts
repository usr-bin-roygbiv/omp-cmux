import { expect, test } from "bun:test";

import { registerCmuxTools } from "../../plugins/cmux/src/tools.ts";

const liveTest = process.env.CMUX_INTEGRATION === "1" ? test : test.skip;

liveTest(
	"discovers live cmux capabilities through the public tool without mutating workspace state",
	async () => {
		const registered = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		registerCmuxTools({
			registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				registered.set(tool.name, tool);
			},
		} as never);

		const capabilities = registered.get("cmux_capabilities");
		expect(capabilities).toBeDefined();
		const result = (await capabilities!.execute("live-capabilities", {}, new AbortController().signal)) as {
			content: Array<{ type: string; text: string }>;
			details: { operation: string; json?: unknown; result?: { ok: boolean; timedOut: boolean; aborted: boolean } };
			isError?: boolean;
		};

		expect(result.isError).toBe(false);
		expect(result.details.operation).toBe("capabilities");
		expect(result.details.result).toMatchObject({ ok: true, timedOut: false, aborted: false });
		expect(result.details.json).toBeDefined();
		expect(result.content[0]?.text.length).toBeGreaterThan(0);
	},
	30_000,
);
