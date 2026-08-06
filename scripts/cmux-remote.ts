#!/usr/bin/env bun

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { open, readFile, realpath, stat, watch } from "node:fs/promises";

export const REMOTE_CUSTOM_TYPE = "cmux_remote_notification_v1";
export const REMOTE_NOTIFICATION_MESSAGES = {
   input: "OMP is waiting for your response",
   approval: "OMP needs tool approval",
   plan: "Plan ready for approval",
   completion: "OMP turn completed",
   blocked: "OMP turn blocked",
   error: "OMP turn failed",
} as const;

type RemoteNotificationKind = keyof typeof REMOTE_NOTIFICATION_MESSAGES;

export interface RemoteNotificationEvent {
   version: 1;
   kind: RemoteNotificationKind;
   eventId: string;
   sessionId: string;
   timestamp: string;
   message: (typeof REMOTE_NOTIFICATION_MESSAGES)[RemoteNotificationKind];
}

export interface InventoryRow {
   session: string;
   paneId: string;
   cwd: string;
   command: string;
   pid: number;
   attached: boolean;
}

export interface SpawnedChild {
   exited: Promise<number>;
   kill(signal?: number | NodeJS.Signals): void;
   stdout?: ReadableStream<Uint8Array> | null;
}

export type SpawnChild = (argv: string[], options?: { stdin?: "inherit" | "ignore"; stdout?: "inherit" | "pipe" | "ignore"; stderr?: "inherit" | "pipe" | "ignore" }) => SpawnedChild;

interface BunSpawnedChild extends SpawnedChild {
   stdout: ReadableStream<Uint8Array>;
   stderr: ReadableStream<Uint8Array>;
}

declare const Bun: {
   spawn(argv: string[], options?: Parameters<SpawnChild>[1]): BunSpawnedChild;
};

const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_SSH_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9.@:_-]*$/u;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9_./-]+$/u;
const SAFE_CMUX_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const NATIVE_EVENT_KEYS = ["eventId", "kind", "message", "sessionId", "timestamp", "version"];
const INVENTORY_FORMAT = "#{session_name}\\t#{pane_id}\\t#{pane_current_path}\\t#{pane_current_command}\\t#{pane_pid}\\t#{session_attached}";
const PANE_FORMAT = "#{pane_id}\\t#{pane_tty}\\t#{pane_current_path}\\t#{pane_current_command}\\t#{pane_pid}";
const EXCLUDED_SESSIONS = new Set(["woodpecker-analysis-html"]);
const MAX_EVENT_LINE_BYTES = 16 * 1024;

function record(value: unknown): Record<string, unknown> | null {
   return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown, max = 512): value is string {
   return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\n") && !value.includes("\r");
}

function assertSession(session: string): void {
   if (!SAFE_SESSION.test(session)) throw new Error(`invalid tmux session: ${JSON.stringify(session)}`);
}

function assertHost(host: string): void {
   if (!SAFE_SSH_DESTINATION.test(host)) throw new Error(`invalid SSH destination: ${JSON.stringify(host)}`);
}

function assertRemotePath(path: string): void {
   if (!SAFE_REMOTE_PATH.test(path)) throw new Error(`invalid remote script path: ${JSON.stringify(path)}`);
}

function assertCmuxId(id: string, label: string): void {
   if (!SAFE_CMUX_ID.test(id)) throw new Error(`invalid ${label}: ${JSON.stringify(id)}`);
}

export function parseInventoryOutput(output: string): InventoryRow[] {
   const rows: InventoryRow[] = [];
   for (const line of output.split(/\r?\n/u)) {
      if (!line) continue;
      const fields = line.split(line.includes("\t") ? "\t" : "\\t");
      if (fields.length !== 6) continue;
      const [session, paneId, cwd, command, pidText, attachedText] = fields;
      const pid = Number(pidText);
      if (!SAFE_SESSION.test(session) || !/^%\d+$/u.test(paneId) || !cwd || !command || !Number.isSafeInteger(pid) || pid <= 0 || !/^[01]$/u.test(attachedText)) continue;
      rows.push({ session, paneId, cwd, command, pid, attached: attachedText === "1" });
   }
   return rows;
}

export function filterInventory(rows: InventoryRow[]): InventoryRow[] {
   const bySession = new Map<string, InventoryRow>();
   for (const row of rows) {
      if (EXCLUDED_SESSIONS.has(row.session) || /autoresearch/iu.test(row.session)) continue;
      if (basename(row.command) !== "bun") continue;
      if (!bySession.has(row.session)) bySession.set(row.session, row);
   }
   return [...bySession.values()].sort((left, right) => left.session.localeCompare(right.session));
}

export function parseRemoteNotificationLine(line: string): RemoteNotificationEvent | null {
   if (line.length === 0 || line.length > MAX_EVENT_LINE_BYTES || !line.includes(`"customType":"${REMOTE_CUSTOM_TYPE}"`)) return null;
   let value: unknown;
   try {
      value = JSON.parse(line);
   } catch {
      return null;
   }
   const envelope = record(value);
   if (!envelope || envelope.type !== "custom" || envelope.customType !== REMOTE_CUSTOM_TYPE) return null;
   const data = record(envelope.data);
   if (!data || Object.keys(data).sort().join("\0") !== NATIVE_EVENT_KEYS.join("\0")) return null;
   if (data.version !== 1 || !nonEmptyString(data.kind, 32) || !(data.kind in REMOTE_NOTIFICATION_MESSAGES)) return null;
   const kind = data.kind as RemoteNotificationKind;
   if (!nonEmptyString(data.eventId) || !nonEmptyString(data.sessionId) || !nonEmptyString(data.timestamp, 64) || !ISO_TIMESTAMP.test(data.timestamp)) return null;
   if (!nonEmptyString(data.message, 128) || data.message !== REMOTE_NOTIFICATION_MESSAGES[kind]) return null;
   return data as unknown as RemoteNotificationEvent;
}

export class RemoteEventDeduper {
   readonly #eventIds = new Set<string>();

   get size(): number {
      return this.#eventIds.size;
   }

   accept(event: RemoteNotificationEvent): boolean {
      if (this.#eventIds.has(event.eventId)) return false;
      this.#eventIds.add(event.eventId);
      return true;
   }
}

export function buildReadOnlyAttachArgv(ssh: string, host: string, session: string): string[] {
   assertHost(host);
   assertSession(session);
   return [ssh, "-tt", host, "tmux", "attach-session", "-r", "-t", session];
}

export function buildRemoteHelperArgv(ssh: string, host: string, remoteScript: string, command: "remote-stream", session: string): string[] {
   assertHost(host);
   assertRemotePath(remoteScript);
   assertSession(session);
   return [ssh, "-T", host, "bun", remoteScript, command, session];
}

export function buildInventoryArgv(ssh: string, host: string): string[] {
   assertHost(host);
   return [ssh, "-T", host, `tmux list-panes -a -F '${INVENTORY_FORMAT}'`];
}

export function buildOpenSurfaceArgv(cmux: string, workspaceId: string): string[] {
   assertCmuxId(workspaceId, "cmux workspace id");
   return [cmux, "new-surface", "--type", "terminal", "--workspace", workspaceId, "--focus", "false", "--json"];
}

export function buildCmuxNotifyArgv(cmux: string, workspaceId: string, surfaceId: string, message: string): string[] {
   assertCmuxId(workspaceId, "cmux workspace id");
   assertCmuxId(surfaceId, "cmux surface id");
   if (!Object.values(REMOTE_NOTIFICATION_MESSAGES).includes(message as never)) throw new Error("refusing non-canonical notification message");
   return [cmux, "notify", "--workspace", workspaceId, "--surface", surfaceId, "--title", "Remote OMP", "--body", message];
}

function shellQuote(value: string): string {
   return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildSurfaceLaunchText(localScript: string, session: string, workspaceId: string, surfaceId: string): string {
   assertSession(session);
   assertCmuxId(workspaceId, "cmux workspace id");
   assertCmuxId(surfaceId, "cmux surface id");
   return `exec bun ${shellQuote(localScript)} attach ${shellQuote(session)} --workspace ${shellQuote(workspaceId)} --surface ${shellQuote(surfaceId)}\n`;
}

function spawnDefault(argv: string[], options: Parameters<SpawnChild>[1] = {}): SpawnedChild {
   return Bun.spawn(argv, options) as unknown as SpawnedChild;
}

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
   const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
   const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
   ]);
   return { code, stdout, stderr };
}

async function consumeNotificationStream(stream: ReadableStream<Uint8Array> | null | undefined, onLine: (line: string) => Promise<void>): Promise<void> {
   if (!stream) return;
   const reader = stream.getReader();
   const decoder = new TextDecoder();
   let pending = "";
   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         pending += decoder.decode(value, { stream: true });
         while (true) {
            const newline = pending.indexOf("\n");
            if (newline < 0) break;
            const line = pending.slice(0, newline).replace(/\r$/u, "");
            pending = pending.slice(newline + 1);
            await onLine(line);
         }
         if (pending.length > MAX_EVENT_LINE_BYTES) pending = "";
      }
   } finally {
      reader.releaseLock();
   }
}

export async function runSurfaceClient(options: {
   session: string;
   host: string;
   remoteScript: string;
   workspaceId: string;
   surfaceId: string;
   spawn?: SpawnChild;
   notify?: (event: RemoteNotificationEvent) => Promise<void>;
   signal?: AbortSignal;
   ssh?: string;
   cmux?: string;
}): Promise<number> {
   const spawn = options.spawn ?? spawnDefault;
   const ssh = options.ssh ?? "ssh";
   const cmux = options.cmux ?? "cmux";
   const attach = spawn(buildReadOnlyAttachArgv(ssh, options.host, options.session), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
   const stream = spawn(buildRemoteHelperArgv(ssh, options.host, options.remoteScript, "remote-stream", options.session), { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
   const deduper = new RemoteEventDeduper();
   const notify = options.notify ?? (async (event: RemoteNotificationEvent) => {
      const child = spawn(buildCmuxNotifyArgv(cmux, options.workspaceId, options.surfaceId, event.message), { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      if ((await child.exited) !== 0) throw new Error("cmux notification failed");
   });
   const consuming = consumeNotificationStream(stream.stdout, async (line) => {
      const event = parseRemoteNotificationLine(line);
      if (event && deduper.accept(event)) await notify(event);
   });
   void consuming.catch((error) => console.error(`cmux-linux-host: notification stream failed: ${String(error)}`));

   let aborted = false;
   const stop = () => {
      aborted = true;
      attach.kill("SIGTERM");
      stream.kill("SIGTERM");
   };
   options.signal?.addEventListener("abort", stop, { once: true });
   if (options.signal?.aborted) stop();

   try {
      const result = await Promise.race([
         attach.exited.then((code) => ({ source: "attach" as const, code })),
         stream.exited.then((code) => ({ source: "stream" as const, code })),
      ]);
      if (result.source === "attach") stream.kill("SIGTERM");
      else attach.kill("SIGTERM");
      return aborted ? 130 : result.code;
   } finally {
      options.signal?.removeEventListener("abort", stop);
   }
}

export interface BreadcrumbMetadata {
   paneId: string;
   paneTty?: string;
   breadcrumbPath: string;
   paneCwd: string;
   breadcrumb: string;
   headerLine: string;
}

export function validateCanonicalBreadcrumb(metadata: BreadcrumbMetadata): string | null {
   const ttyId = metadata.paneTty?.startsWith("/dev/") ? metadata.paneTty.slice(5).replaceAll("/", "-") : undefined;
   const breadcrumbId = basename(metadata.breadcrumbPath);
   if (!/^%\d+$/u.test(metadata.paneId) || (breadcrumbId !== `tmux-${metadata.paneId}` && breadcrumbId !== ttyId)) return null;
   const breadcrumbLines = metadata.breadcrumb.replace(/\n$/u, "").split("\n");
   if (breadcrumbLines.length !== 2) return null;
   const [breadcrumbCwd, sessionFile] = breadcrumbLines;
   if (!isAbsolute(sessionFile) || breadcrumbCwd !== metadata.paneCwd) return null;
   let headerValue: unknown;
   try {
      headerValue = JSON.parse(metadata.headerLine);
   } catch {
      return null;
   }
   const header = record(headerValue);
   if (!header || header.type !== "session" || !nonEmptyString(header.id) || header.cwd !== metadata.paneCwd) return null;
   if (!basename(sessionFile).endsWith(`_${header.id}.jsonl`)) return null;
   return sessionFile;
}

export function findSessionHeaderLine(text: string): string | null {
   const completeLines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n").slice(0, -1);
   for (const [index, line] of completeLines.entries()) {
      if (!line || index > 1) return null;
      try {
         const entry = record(JSON.parse(line));
         if (entry?.type === "session") return line;
         if (index !== 0 || entry?.type !== "title") return null;
      } catch {
         return null;
      }
   }
   return null;
}

async function readSessionHeaderLine(path: string): Promise<string> {
   const handle = await open(path, "r");
   try {
      const buffer = Buffer.alloc(4096);
      let text = "";
      let position = 0;
      while (text.length <= MAX_EVENT_LINE_BYTES) {
         const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
         if (bytesRead === 0) break;
         position += bytesRead;
         text += buffer.subarray(0, bytesRead).toString("utf8");
         const header = findSessionHeaderLine(text);
         if (header) return header;
      }
      throw new Error("session header is missing or too large");
   } finally {
      await handle.close();
   }
}

function parseProcessEnvironment(bytes: Uint8Array): Record<string, string> {
   const values: Record<string, string> = {};
   for (const item of Buffer.from(bytes).toString("utf8").split("\0")) {
      const separator = item.indexOf("=");
      if (separator > 0) values[item.slice(0, separator)] = item.slice(separator + 1);
   }
   return values;
}

async function discoverCanonicalSession(session: string): Promise<string> {
   assertSession(session);
   const tmux = await capture(["tmux", "list-panes", "-t", session, "-F", PANE_FORMAT]);
   if (tmux.code !== 0) throw new Error(tmux.stderr.trim() || `tmux session not found: ${session}`);
   const panes = tmux.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.split(line.includes("\t") ? "\t" : "\\t"));
   const pane = panes.find((fields) => fields.length === 5 && /^%\d+$/u.test(fields[0]!) && fields[1]!.startsWith("/dev/") && basename(fields[3]!) === "bun" && /^\d+$/u.test(fields[4]!));
   if (!pane) throw new Error(`no bun OMP pane found in tmux session ${session}`);
   const [paneId, paneTty, rawPaneCwd, , pid] = pane as [string, string, string, string, string];
   const processEnvironment = parseProcessEnvironment(new Uint8Array(await readFile(`/proc/${pid}/environ`)));
   const agentDir = processEnvironment.PI_CODING_AGENT_DIR || join(processEnvironment.HOME || homedir(), ".omp", "agent");
   const ttyId = paneTty.slice(5).replaceAll("/", "-");
   let breadcrumbPath = "";
   let breadcrumb = "";
   for (const terminalId of [ttyId, `tmux-${paneId}`]) {
      const candidate = join(agentDir, "terminal-sessions", terminalId);
      try {
         breadcrumb = await readFile(candidate, "utf8");
         breadcrumbPath = candidate;
         break;
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
   }
   if (!breadcrumbPath) throw new Error(`no OMP terminal breadcrumb found for ${session}`);
   const breadcrumbLines = breadcrumb.replace(/\n$/u, "").split("\n");
   if (breadcrumbLines.length !== 2) throw new Error(`invalid OMP terminal breadcrumb for ${session}`);
   const canonicalPaneCwd = await realpath(rawPaneCwd);
   const canonicalBreadcrumbCwd = await realpath(breadcrumbLines[0]!);
   const canonicalSessionFile = await realpath(breadcrumbLines[1]!);
   const headerLine = await readSessionHeaderLine(canonicalSessionFile);
   const parsedHeader = record(JSON.parse(headerLine));
   if (!parsedHeader || !nonEmptyString(parsedHeader.cwd, 4096)) throw new Error(`invalid OMP session header for ${session}`);
   const canonical = validateCanonicalBreadcrumb({
      paneId,
      paneTty,
      breadcrumbPath,
      paneCwd: canonicalPaneCwd,
      breadcrumb: `${canonicalBreadcrumbCwd}\n${canonicalSessionFile}\n`,
      headerLine: JSON.stringify({ ...parsedHeader, cwd: await realpath(parsedHeader.cwd) }),
   });
   if (!canonical) throw new Error(`OMP breadcrumb/session header mismatch for ${session}`);
   return canonical;
}

class MatchingLineScanner {
   #pending = "";
   #discarding = false;

   push(text: string, emit: (line: string) => void): void {
      let remaining = text;
      while (remaining.length > 0) {
         const newline = remaining.indexOf("\n");
         const fragment = newline < 0 ? remaining : remaining.slice(0, newline);
         remaining = newline < 0 ? "" : remaining.slice(newline + 1);
         if (!this.#discarding) {
            this.#pending += fragment;
            if (this.#pending.length > MAX_EVENT_LINE_BYTES) {
               this.#pending = "";
               this.#discarding = true;
            }
         }
         if (newline >= 0) {
            if (!this.#discarding) {
               const line = this.#pending.replace(/\r$/u, "");
               if (parseRemoteNotificationLine(line)) emit(line);
            }
            this.#pending = "";
            this.#discarding = false;
         }
      }
   }

   reset(): void {
      this.#pending = "";
      this.#discarding = false;
   }
}

async function streamRemoteEvents(sessionFile: string, signal: AbortSignal): Promise<void> {
   const scanner = new MatchingLineScanner();
   let offset = (await stat(sessionFile)).size;
   const changes = watch(dirname(sessionFile), { signal });
   try {
      for await (const change of changes) {
         if (change.filename && change.filename !== basename(sessionFile)) continue;
         const current = await stat(sessionFile);
         if (current.size < offset) {
            offset = current.size;
            scanner.reset();
            continue;
         }
         if (current.size === offset) continue;
         const handle = await open(sessionFile, "r");
         try {
            const chunk = Buffer.alloc(64 * 1024);
            while (offset < current.size) {
               const length = Math.min(chunk.length, current.size - offset);
               const { bytesRead } = await handle.read(chunk, 0, length, offset);
               if (bytesRead === 0) break;
               offset += bytesRead;
               scanner.push(chunk.subarray(0, bytesRead).toString("utf8"), (line) => process.stdout.write(`${line}\n`));
            }
         } finally {
            await handle.close();
         }
      }
   } catch (error) {
      if (!signal.aborted) throw error;
   }
}

interface HostProfile {
   PI_REMOTE_TAILSCALE_HOST: string;
   PI_REMOTE_AGENT_FLEET_ROOT: string;
}

async function loadHostProfile(): Promise<HostProfile> {
   const profilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../config/linux-host/host-profile.conf");
   const values: Record<string, string> = {};
   for (const rawLine of (await readFile(profilePath, "utf8")).split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
   }
   if (!values.PI_REMOTE_TAILSCALE_HOST || !values.PI_REMOTE_AGENT_FLEET_ROOT) throw new Error(`incomplete host profile: ${profilePath}`);
   return values as unknown as HostProfile;
}

function formatInventory(rows: InventoryRow[], dryRun: boolean): string {
   const lines = ["SESSION\tATTACHED\tPANE\tCOMMAND\tCWD"];
   for (const row of rows) lines.push(`${dryRun ? "candidate " : ""}${row.session}\t${row.attached ? "yes" : "no"}\t${row.paneId}\t${row.command}\t${row.cwd}`);
   return lines.join("\n");
}

export function createdSurfaceId(output: string): string {
   let value: unknown;
   try {
      value = JSON.parse(output);
   } catch {
      throw new Error(`cmux returned invalid surface JSON: ${output.trim()}`);
   }
   const queue: unknown[] = [value];
   while (queue.length > 0) {
      const current = queue.shift();
      const object = record(current);
      if (!object) continue;
      for (const key of ["surface_ref", "surface_id", "surfaceId", "id"]) {
         if (typeof object[key] === "string" && SAFE_CMUX_ID.test(object[key])) return object[key];
      }
      queue.push(...Object.values(object));
   }
   throw new Error("cmux surface response did not contain a surface id");
}

async function liveInventory(host: string): Promise<InventoryRow[]> {
   const result = await capture(buildInventoryArgv(process.env.CMUX_REMOTE_SSH_BIN || "ssh", host));
   if (result.code !== 0) throw new Error(result.stderr.trim() || "remote tmux inventory failed");
   return filterInventory(parseInventoryOutput(result.stdout));
}

async function openCandidates(rows: InventoryRow[], workspaceId: string, localScript: string): Promise<void> {
   const cmux = process.env.CMUX_REMOTE_CMUX_BIN || "cmux";
   for (const row of rows) {
      const opened = await capture(buildOpenSurfaceArgv(cmux, workspaceId));
      if (opened.code !== 0) throw new Error(opened.stderr.trim() || `failed to open surface for ${row.session}`);
      const surfaceId = createdSurfaceId(opened.stdout);
      const rename = await capture([cmux, "rename-tab", "--workspace", workspaceId, "--surface", surfaceId, `linux-host: ${row.session}`]);
      if (rename.code !== 0) throw new Error(rename.stderr.trim() || `failed to name surface for ${row.session}`);
      const launch = buildSurfaceLaunchText(localScript, row.session, workspaceId, surfaceId);
      const sent = await capture([cmux, "send", "--workspace", workspaceId, "--surface", surfaceId, launch]);
      if (sent.code !== 0) throw new Error(sent.stderr.trim() || `failed to launch client for ${row.session}`);
   }
}

function option(args: string[], name: string): string | undefined {
   const index = args.indexOf(name);
   return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
   const command = args[0];
   if (command === "remote-inventory") {
      const result = await capture(["tmux", "list-panes", "-a", "-F", INVENTORY_FORMAT]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "tmux inventory failed");
      process.stdout.write(`${JSON.stringify(filterInventory(parseInventoryOutput(result.stdout)))}\n`);
      return 0;
   }
   if (command === "remote-discover" || command === "remote-stream") {
      const session = args[1] || "";
      const sessionFile = await discoverCanonicalSession(session);
      if (command === "remote-discover") {
         process.stdout.write(`${sessionFile}\n`);
         return 0;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
      try {
         await streamRemoteEvents(sessionFile, controller.signal);
      } finally {
         process.off("SIGINT", stop);
         process.off("SIGTERM", stop);
         process.off("SIGHUP", stop);
      }
      return 0;
   }

   const profile = await loadHostProfile();
   const host = `user@${profile.PI_REMOTE_TAILSCALE_HOST}`;
   const remoteScript = join(profile.PI_REMOTE_AGENT_FLEET_ROOT, "workspace-root/scripts/cmux-linux-host.ts");
   const localScript = fileURLToPath(import.meta.url);
   if (command === "attach") {
      const session = args[1] || "";
      const workspaceId = option(args, "--workspace") || process.env.CMUX_WORKSPACE_ID || "";
      const surfaceId = option(args, "--surface") || process.env.CMUX_SURFACE_ID || "";
      assertCmuxId(workspaceId, "cmux workspace id");
      assertCmuxId(surfaceId, "cmux surface id");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
      try {
         return await runSurfaceClient({ session, host, remoteScript, workspaceId, surfaceId, signal: controller.signal });
      } finally {
         process.off("SIGINT", stop);
         process.off("SIGTERM", stop);
         process.off("SIGHUP", stop);
      }
   }

   if (!["inventory", "dry-run", "open-all", "open-one"].includes(command || "")) {
      console.error("usage: cmux-linux-host.ts inventory|dry-run|open-all [--dry-run]|open-one <session> [--dry-run]");
      return 2;
   }
   const rows = await liveInventory(host);
   const selected = command === "open-one" ? rows.filter((row) => row.session === args[1]) : rows;
   if (command === "open-one" && selected.length !== 1) throw new Error(`session is not an eligible OMP candidate: ${JSON.stringify(args[1] || "")}`);
   const dryRun = command === "dry-run" || args.includes("--dry-run") || command === "inventory";
   process.stdout.write(`${formatInventory(selected, dryRun)}\n`);
   if (dryRun) return 0;
   const workspaceId = process.env.CMUX_WORKSPACE_ID || "";
   assertCmuxId(workspaceId, "CMUX_WORKSPACE_ID");
   await openCandidates(selected, workspaceId, localScript);
   return 0;
}

if (import.meta.main) {
   try {
      process.exitCode = await main(process.argv.slice(2));
   } catch (error) {
      console.error(`cmux-linux-host: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
   }
}
