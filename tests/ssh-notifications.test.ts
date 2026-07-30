import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forwardSshDesktopNotification } from "../plugins/cmux/src/ssh-notifications.ts";

function processFixture(
	root: string,
	pid: number,
	argv: string[],
	environment: Record<string, string>,
): void {
	const directory = join(root, String(pid));
	mkdirSync(directory);
	writeFileSync(join(directory, "cmdline"), `${argv.join("\0")}\0`);
	writeFileSync(
		join(directory, "environ"),
		`${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\0")}\0`,
	);
}

describe("SSH desktop notification forwarding", () => {
	test("writes one bounded OSC 777 notification to the inherited SSH TTY", () => {
		const writes: Array<{ path: string; payload: string }> = [];
		const delivered = forwardSshDesktopNotification(
			{ title: "OMP turn complete\u0007ignored", body: "Finished\nremote work" },
			{
				env: {
					CMUX_TUI_SOCKET: "/run/user/1000/cmux/main.sock",
					SSH_TTY: "/dev/pts/7",
				},
				platform: "linux",
				procRoot: "/missing-proc",
				writeTty(path, payload) {
					writes.push({ path, payload });
				},
			},
		);

		expect(delivered).toBe(1);
		expect(writes).toEqual([{
			path: "/dev/pts/7",
			payload: "\u001b]777;notify;OMP turn complete ignored;Finished remote work\u001b\\",
		}]);
		expect(writes[0]!.payload.length).toBeLessThan(1_024);
	});

	test("prefers live matching SSH attach viewers and deduplicates their TTYs", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-cmux-proc-"));
		try {
			const socket = "/run/user/1000/cmux/agents.sock";
			processFixture(root, 101, ["/usr/local/bin/cmux-tui", "attach", "--socket", socket], {
				CMUX_TUI_SOCKET: socket,
				SSH_CONNECTION: "opaque",
				SSH_TTY: "/dev/pts/11",
			});
			processFixture(root, 102, ["cmux", "attach", "--session", "agents"], {
				CMUX_MUX_SOCKET: socket,
				SSH_TTY: "/dev/pts/11",
			});
			processFixture(root, 103, ["cmux-tui", "attach", "--session", "other"], {
				SSH_TTY: "/dev/pts/12",
			});
			processFixture(root, 104, ["cmux-tui", "notify", "--title", "not-a-viewer"], {
				CMUX_TUI_SOCKET: socket,
				SSH_TTY: "/dev/pts/13",
			});

			const paths: string[] = [];
			const delivered = forwardSshDesktopNotification(
				{ title: "OMP needs your input", body: "Waiting" },
				{
					env: { CMUX_TUI_SOCKET: socket, SSH_TTY: "/dev/pts/4" },
					platform: "linux",
					procRoot: root,
					writeTty(path) {
						paths.push(path);
					},
				},
			);

			expect(delivered).toBe(1);
			expect(paths).toEqual(["/dev/pts/11"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("fails closed outside Linux TUI routes and for unsafe TTY paths", () => {
		const writes: string[] = [];
		const writeTty = (path: string) => writes.push(path);
		expect(forwardSshDesktopNotification(
			{ title: "Done", body: "Done" },
			{ env: { CMUX_TUI_SOCKET: "/tmp/main.sock", SSH_TTY: "/dev/pts/1" }, platform: "darwin", writeTty },
		)).toBe(0);
		expect(forwardSshDesktopNotification(
			{ title: "Done", body: "Done" },
			{ env: { SSH_TTY: "/dev/pts/1" }, platform: "linux", writeTty },
		)).toBe(0);
		expect(forwardSshDesktopNotification(
			{ title: "Done", body: "Done" },
			{ env: { CMUX_TUI_SOCKET: "/tmp/main.sock", SSH_TTY: "/tmp/not-a-tty" }, platform: "linux", writeTty },
		)).toBe(0);
		expect(writes).toEqual([]);
	});
});
