import {
	closeSync,
	constants,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";

const CMUX_SOCKET_KEYS = ["CMUX_TUI_SOCKET", "CMUX_MUX_SOCKET"] as const;
const SSH_TTY_PATTERN = /^\/dev\/pts\/[0-9]+$/;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 640;

export interface SshDesktopNotification {
	title: string;
	body: string;
}

export interface SshDesktopNotificationOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	procRoot?: string;
	writeTty?: (path: string, payload: string) => void;
}

function nulValues(path: string): string[] {
	try {
		return readFileSync(path).toString("utf8").split("\0").filter(Boolean);
	} catch {
		return [];
	}
}

function environment(values: readonly string[]): NodeJS.ProcessEnv {
	const parsed: NodeJS.ProcessEnv = {};
	for (const value of values) {
		const separator = value.indexOf("=");
		if (separator > 0) parsed[value.slice(0, separator)] = value.slice(separator + 1);
	}
	return parsed;
}


function isCmuxAttach(argv: readonly string[]): boolean {
	if (!argv.slice(1).includes("attach")) return false;
	return argv.slice(0, 2).some(value => {
		const executable = basename(value);
		return executable === "cmux" || executable === "cmux-tui";
	});
}


function viewerMatches(argv: readonly string[], env: NodeJS.ProcessEnv, socket: string): boolean {
	if (!isCmuxAttach(argv)) return false;
	if (CMUX_SOCKET_KEYS.some(key => env[key] === socket)) return true;
	let explicitSocket: string | undefined;
	let explicitSession: string | undefined;
	for (let index = 1; index < argv.length - 1; index += 1) {
		if (argv[index] === "--socket") explicitSocket = argv[index + 1];
		if (argv[index] === "--session") explicitSession = argv[index + 1];
	}
	if (explicitSocket) return explicitSocket === socket;
	const socketSession = basename(socket).replace(/\.sock$/, "") || "main";
	return (explicitSession ?? "main") === socketSession;
}

function safeSshTty(env: NodeJS.ProcessEnv): string | undefined {
	const tty = env.SSH_TTY?.trim();
	return tty && SSH_TTY_PATTERN.test(tty) ? tty : undefined;
}

function attachedSshTtys(procRoot: string, socket: string): string[] {
	const targets = new Set<string>();
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const root = join(procRoot, entry);
		const argv = nulValues(join(root, "cmdline"));
		const viewerEnv = environment(nulValues(join(root, "environ")));
		if (!viewerMatches(argv, viewerEnv, socket)) continue;
		const tty = safeSshTty(viewerEnv);
		if (tty) targets.add(tty);
	}
	return [...targets].sort();
}

function cleanOscField(value: string, limit: number, fallback: string): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f;]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
	return cleaned || fallback;
}

function osc777(notification: SshDesktopNotification): string {
	const title = cleanOscField(notification.title, MAX_TITLE_LENGTH, "OMP");
	const body = cleanOscField(notification.body, MAX_BODY_LENGTH, "OMP needs attention");
	return `\u001b]777;notify;${title};${body}\u001b\\`;
}

function writeTerminal(path: string, payload: string): void {
	const descriptor = openSync(path, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
	try {
		const bytes = Buffer.from(payload);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Forward a cmux TUI notification through the outer SSH pseudo-terminal.
 *
 * Live attach viewers take precedence over an inherited SSH_TTY so a detached
 * session cannot notify a stale terminal. Every operation is local, bounded,
 * and best-effort; missing or ambiguous routes fail closed.
 */
export function forwardSshDesktopNotification(
	notification: SshDesktopNotification,
	options: SshDesktopNotificationOptions = {},
): number {
	const env = options.env ?? process.env;
	if ((options.platform ?? process.platform) !== "linux") return 0;
	const socket = CMUX_SOCKET_KEYS.map(key => env[key]?.trim()).find(Boolean);
	if (!socket) return 0;

	const attached = attachedSshTtys(options.procRoot ?? "/proc", socket);
	const fallback = safeSshTty(env);
	const targets = attached.length > 0 ? attached : fallback ? [fallback] : [];
	if (targets.length === 0) return 0;

	const payload = osc777(notification);
	const writeTty = options.writeTty ?? writeTerminal;
	let delivered = 0;
	for (const target of targets) {
		try {
			writeTty(target, payload);
			delivered += 1;
		} catch {
			// Notification forwarding must never disturb the agent or native TUI path.
		}
	}
	return delivered;
}
