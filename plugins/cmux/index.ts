import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCmuxLifecycle } from "./src/lifecycle.ts";
import { registerCmuxTools } from "./src/tools.ts";

export default function cmuxPlugin(api: ExtensionAPI): void {
	process.env["CMUX_OMP_HOOKS_DISABLED"] = "1";
	registerCmuxTools(api);
	registerCmuxLifecycle(api);
}
