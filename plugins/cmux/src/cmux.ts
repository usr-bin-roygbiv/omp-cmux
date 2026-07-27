import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 16 * 1_048_576;
const KILL_GRACE_MS = 250;

const SAFE_ENVIRONMENT_KEYS = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
	"CMUX_SOCKET",
	"CMUX_SOCKET_PATH",
	"CMUX_SOCKET_PASSWORD",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_WINDOW_ID",
	"CMUX_TAB_ID",
	"CMUX_PANEL_ID",
	"CMUX_TAG",
	"CMUX_TUI_SOCKET",
	"CMUX_TUI_SURFACE_ID",
	"CMUX_TUI_WORKSPACE_ID",
	"CMUX_MUX_SOCKET",
]);

export interface CmuxTarget {
	workspaceId?: string;
	surfaceId?: string;
	windowId?: string;
}

export interface CmuxRunOptions {
	binary?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	stdin?: string | Uint8Array;
	signal?: AbortSignal;
	cwd?: string;
	/** Environment source. Only the fixed allowlist is inherited by the child. */
	env?: NodeJS.ProcessEnv;
	/** Test seam; production callers should use the default direct process spawner. */
	spawn?: typeof nodeSpawn;
}

export interface CmuxCommandError {
	code: "ABORTED" | "INVALID_ARGUMENT" | "SPAWN_ERROR" | "TIMEOUT" | "EXIT_ERROR";
	message: string;
}

export interface CmuxCommandResult {
	ok: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	truncated: {
		stdout: boolean;
		stderr: boolean;
	};
	error?: CmuxCommandError;
}

function configuredInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
		throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
	}
	return resolved;
}

function validateArg(value: string, label: string): string {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new TypeError(`${label} must be a NUL-free string`);
	}
	return value;
}

function exactIdentity(value: string | undefined, label: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new TypeError(`${label} is required; pass it explicitly or set the matching cmux environment variable`);
	}
	return validateArg(normalized, label);
}

/** Resolve an explicit binary path without ever invoking a shell. */
export function resolveCmuxBinary(
	override = process.env.CMUX_OMP_BINARY,
	cwd = process.cwd(),
): string {
	const candidate = override?.trim() || "cmux";
	validateArg(candidate, "cmux binary");
	if (!candidate.includes("/") && !candidate.includes("\\")) return candidate;
	const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
	try {
		return realpathSync(absolute);
	} catch {
		// Keep the resolved path so spawn reports a deterministic missing-binary failure.
		return absolute;
	}
}

/** Build the only environment map that may be passed to a cmux child process. */
export function buildSafeEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENVIRONMENT_KEYS) {
		const value = overrides[key] ?? source[key];
		if (value !== undefined && !value.includes("\0")) safe[key] = value;
	}
	// Prevent cmux from also running legacy OMP hooks for operations initiated here.
	safe.CMUX_OMP_HOOKS_DISABLED = "1";
	return safe;
}

/** Resolve a workspace only from an explicit value or the caller's injected identity. */
export function exactWorkspaceTarget(
	explicit?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return exactIdentity(explicit ?? env.CMUX_WORKSPACE_ID, "workspace identity");
}

/** Resolve a surface and its owning workspace without consulting cmux focus state. */
export function exactSurfaceTarget(
	target: Pick<CmuxTarget, "workspaceId" | "surfaceId"> = {},
	env: NodeJS.ProcessEnv = process.env,
): Required<Pick<CmuxTarget, "workspaceId" | "surfaceId">> {
	return {
		workspaceId: exactWorkspaceTarget(target.workspaceId, env),
		surfaceId: exactIdentity(target.surfaceId ?? env.CMUX_SURFACE_ID, "surface identity"),
	};
}

/** Build explicit CLI routing flags and fail closed when the required identity is absent. */
export function exactTargetArgs(
	target: CmuxTarget,
	requirement: "workspace" | "surface",
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const args: string[] = [];
	if (target.windowId !== undefined) args.push("--window", exactIdentity(target.windowId, "window identity"));
	if (requirement === "surface") {
		const exact = exactSurfaceTarget(target, env);
		args.push("--workspace", exact.workspaceId, "--surface", exact.surfaceId);
	} else {
		args.push("--workspace", exactWorkspaceTarget(target.workspaceId, env));
	}
	return args;
}

/** Parse the JSON emitted by `cmux capabilities`, `cmux rpc`, or `--json`. */
export function parseCmuxJson<T = unknown>(text: string): T {
	const trimmed = text.trim();
	if (!trimmed) throw new SyntaxError("cmux returned empty JSON output");
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new SyntaxError("cmux returned invalid JSON output");
	}
}

interface BoundedCapture {
	append(chunk: Buffer | string): void;
	text(): string;
	readonly truncated: boolean;
}

function boundedCapture(limit: number): BoundedCapture {
	const chunks: Buffer[] = [];
	let length = 0;
	let didTruncate = false;
	return {
		append(chunk) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = limit - length;
			if (remaining <= 0) {
				didTruncate ||= buffer.length > 0;
				return;
			}
			const kept = Math.min(remaining, buffer.length);
			if (kept > 0) {
				chunks.push(Buffer.from(buffer.subarray(0, kept)));
				length += kept;
			}
			didTruncate ||= kept < buffer.length;
		},
		text: () => Buffer.concat(chunks, length).toString("utf8"),
		get truncated() {
			return didTruncate;
		},
	};
}

function invalidResult(message: string, aborted = false): CmuxCommandResult {
	return {
		ok: false,
		exitCode: null,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		aborted,
		truncated: { stdout: false, stderr: false },
		error: { code: aborted ? "ABORTED" : "INVALID_ARGUMENT", message },
	};
}

/** Execute cmux directly with argv isolation, bounded capture, cancellation, and timeout. */
export async function runCmux(args: readonly string[], options: CmuxRunOptions = {}): Promise<CmuxCommandResult> {
	if (options.signal?.aborted) return invalidResult("cmux execution was cancelled before start", true);

	let binary: string;
	let timeoutMs: number;
	let maxOutputBytes: number;
	try {
		const env = options.env ?? process.env;
		binary = resolveCmuxBinary(options.binary ?? env.CMUX_OMP_BINARY, options.cwd ?? process.cwd());
		timeoutMs = normalizeLimit(
			options.timeoutMs,
			configuredInteger(env.CMUX_OMP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
			MAX_TIMEOUT_MS,
			"timeoutMs",
		);
		maxOutputBytes = normalizeLimit(
			options.maxOutputBytes,
			configuredInteger(env.CMUX_OMP_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES),
			MAX_OUTPUT_BYTES,
			"maxOutputBytes",
		);
		for (let index = 0; index < args.length; index += 1) validateArg(args[index]!, `argv[${index}]`);
		if (options.stdin !== undefined && typeof options.stdin !== "string" && !(options.stdin instanceof Uint8Array)) {
			throw new TypeError("stdin must be a string or Uint8Array");
		}
	} catch (error) {
		return invalidResult(error instanceof Error ? error.message : "invalid cmux execution options");
	}

	const stdout = boundedCapture(maxOutputBytes);
	const stderr = boundedCapture(maxOutputBytes);
	const spawnImpl = options.spawn ?? nodeSpawn;

	return await new Promise<CmuxCommandResult>((resolveResult) => {
		let child: ReturnType<typeof nodeSpawn>;
		try {
			child = spawnImpl(binary, [...args], {
				cwd: options.cwd,
				env: buildSafeEnvironment(options.env ?? process.env),
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			});
		} catch (error) {
			const code = typeof (error as NodeJS.ErrnoException)?.code === "string" ? (error as NodeJS.ErrnoException).code : "UNKNOWN";
			resolveResult({
				...invalidResult(`failed to start ${basename(binary)} (${code})`),
				error: { code: "SPAWN_ERROR", message: `failed to start cmux (${code})` },
			});
			return;
		}

		let timedOut = false;
		let aborted = false;
		let spawnErrorCode: string | undefined;
		let settled = false;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

		const stop = (reason: "abort" | "timeout") => {
			if (settled) return;
			aborted ||= reason === "abort";
			timedOut ||= reason === "timeout";
			child.kill("SIGTERM");
			forceKillTimer ??= setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, KILL_GRACE_MS);
			forceKillTimer.unref?.();
		};

		const timeout = setTimeout(() => stop("timeout"), timeoutMs);
		timeout.unref?.();
		const onAbort = () => stop("abort");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnErrorCode = typeof error.code === "string" ? error.code : "UNKNOWN";
		});
		child.on("close", (exitCode, exitSignal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);

			let error: CmuxCommandError | undefined;
			if (aborted) error = { code: "ABORTED", message: "cmux execution was cancelled" };
			else if (timedOut) error = { code: "TIMEOUT", message: `cmux execution exceeded ${timeoutMs}ms` };
			else if (spawnErrorCode) error = { code: "SPAWN_ERROR", message: `failed to start cmux (${spawnErrorCode})` };
			else if (exitCode !== 0) error = { code: "EXIT_ERROR", message: `cmux exited with code ${exitCode ?? "unknown"}` };

			resolveResult({
				ok: error === undefined,
				exitCode,
				signal: exitSignal,
				stdout: stdout.text(),
				stderr: stderr.text(),
				timedOut,
				aborted,
				truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
				...(error ? { error } : {}),
			});
		});

		child.stdin?.on("error", () => {
			// A fast child exit can close stdin before end(); process completion owns the result.
		});
		const stdin = options.stdin;
		child.stdin?.end(stdin === undefined || typeof stdin === "string" ? stdin : Buffer.from(stdin));
	});
}
