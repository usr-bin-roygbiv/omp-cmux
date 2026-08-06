const API_BASE = "http://localhost:8080/api/v1/gui-workspaces";
const WORKSPACE_ID_PATTERN = "^gws-[0-9a-f]{24}$";
const capabilities = new Map<string, string>();
const SENSITIVE_KEYS: Record<string, true> = {
   capability: true, capability_hash: true, authorization: true, token: true, password: true,
   secret: true, service_name: true, secret_name: true, backend: true, credentials: true,
};

type Context = { sessionManager: { getSessionId(): string } };
type ToolResult = { content: Array<Record<string, unknown>>; details?: unknown };
type TypeFactory = {
   Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
   Optional(schema: unknown): unknown;
   String(options?: Record<string, unknown>): unknown;
   Integer(options?: Record<string, unknown>): unknown;
   Literal(value: unknown): unknown;
   Union(variants: unknown[]): unknown;
};
type PiApi = {
   typebox: { Type: TypeFactory };
   registerTool(tool: Record<string, unknown>): void;
};

function sessionId(ctx: Context): string {
   const value = ctx.sessionManager.getSessionId();
   if (typeof value !== "string" || !value.trim()) throw new Error("An active OMP session is required");
   return value.trim();
}

function sanitized(value: unknown): unknown {
   if (Array.isArray(value)) return value.map(sanitized);
   if (value && typeof value === "object") {
      return Object.fromEntries(
         Object.entries(value as Record<string, unknown>)
            .filter(([key]) => SENSITIVE_KEYS[key.toLowerCase()] !== true)
            .map(([key, child]) => [key, sanitized(child)]),
      );
   }
   return value;
}

function textResult(value: unknown): ToolResult {
   return { content: [{ type: "text", text: JSON.stringify(sanitized(value)) }] };
}

async function jsonRequest(
   path: string,
   method: "GET" | "POST",
   toolCallId: string,
   ctx: Context,
   body?: unknown,
   capability?: string,
): Promise<Record<string, unknown>> {
   const headers = new Headers({ Accept: "application/json" });
   if (method === "POST") {
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", toolCallId);
      headers.set("X-OMP-Session-Id", sessionId(ctx));
   }
   if (capability) headers.set("X-Gui-Workspace-Capability", capability);
   const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      redirect: "error",
   });
   if (!response.ok) throw new Error(`GUI workspace gateway rejected the request (${response.status})`);
   const contentType = response.headers.get("content-type") ?? "";
   if (!contentType.toLowerCase().includes("application/json")) throw new Error("GUI workspace gateway returned an unexpected response type");
   const payload: unknown = await response.json();
   if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("GUI workspace gateway returned an invalid response");
   return payload as Record<string, unknown>;
}

function workspaceCapability(workspaceId: string): string {
   const value = capabilities.get(workspaceId);
   if (!value) throw new Error("This process does not hold the workspace capability; create the workspace in this OMP process");
   return value;
}

export default function guiWorkspaceExtension(pi: PiApi) {
   const { Type } = pi.typebox;
   const workspaceId = Type.String({ pattern: WORKSPACE_ID_PATTERN });
   const ttl = Type.Union([15, 30, 60, 120].map((value) => Type.Literal(value)));
   const input = Type.Union([
      Type.Object({
         type: Type.Literal("click"),
         x: Type.Integer({ minimum: 0, maximum: 4095 }),
         y: Type.Integer({ minimum: 0, maximum: 4095 }),
         button: Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")]),
      }, { additionalProperties: false }),
      Type.Object({
         type: Type.Literal("key"),
         key: Type.Union(["ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT", "CTRL_L", "CTRL_C", "CTRL_V"].map((value) => Type.Literal(value))),
      }, { additionalProperties: false }),
      Type.Object({
         type: Type.Literal("text"),
         text: Type.String({ minLength: 1, maxLength: 4096 }),
      }, { additionalProperties: false }),
   ]);

   const register = (
      name: string,
      approval: "read" | "write",
      parameters: unknown,
      execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Context) => Promise<ToolResult>,
   ) => pi.registerTool({
      name,
      label: name,
      description: `${name} via the fixed /api/v1/gui-workspaces v1 owner gateway`,
      summary: `${name} GUI workspace operation`,
      loadMode: "discoverable",
      approval,
      parameters,
      execute,
   });

   register(
      "gui_workspace_create",
      "write",
      Type.Object({
         project: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
         revision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
         ttl_minutes: ttl,
         resource_class: Type.Literal("small"),
         egress_profile: Type.Union([Type.Literal("dns-only"), Type.Literal("public-web")]),
         storage_mode: Type.Union([Type.Literal("ephemeral"), Type.Literal("checkpointed"), Type.Literal("durable-profile")]),
         profile_name: Type.Optional(Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" })),
      }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => {
         const payload = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
         const response = await jsonRequest("", "POST", toolCallId, ctx, payload);
         const workspace = response.workspace as Record<string, unknown> | undefined;
         const capability = response.capability;
         if (!workspace || typeof workspace.id !== "string" || typeof capability !== "string" || !capability)
            throw new Error("GUI workspace create response omitted its workspace or capability");
         capabilities.set(workspace.id, capability);
         return textResult({ workspace });
      },
   );

   register(
      "gui_workspace_status",
      "read",
      Type.Object({ workspace_id: workspaceId }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => textResult(await jsonRequest(`/${params.workspace_id}/status`, "GET", toolCallId, ctx)),
   );

   register(
      "gui_workspace_open",
      "read",
      Type.Object({ workspace_id: workspaceId }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => textResult(await jsonRequest(`/${params.workspace_id}/open`, "GET", toolCallId, ctx)),
   );

   register(
      "gui_workspace_snapshot",
      "write",
      Type.Object({ workspace_id: workspaceId }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => textResult(await jsonRequest(`/${params.workspace_id}/snapshot`, "POST", toolCallId, ctx, {}, workspaceCapability(params.workspace_id))),
   );

   register(
      "gui_workspace_extend",
      "write",
      Type.Object({ workspace_id: workspaceId, ttl_minutes: ttl }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => textResult(await jsonRequest(`/${params.workspace_id}/extend`, "POST", toolCallId, ctx, { ttl_minutes: params.ttl_minutes }, workspaceCapability(params.workspace_id))),
   );

   register(
      "gui_workspace_stop",
      "write",
      Type.Object({ workspace_id: workspaceId }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => {
         const result = await jsonRequest(`/${params.workspace_id}/stop`, "POST", toolCallId, ctx, {}, workspaceCapability(params.workspace_id));
         capabilities.delete(params.workspace_id);
         return textResult(result);
      },
   );

   register(
      "gui_workspace_screenshot",
      "read",
      Type.Object({ workspace_id: workspaceId }, { additionalProperties: false }),
      async (_toolCallId, params) => {
         const response = await fetch(`${API_BASE}/${params.workspace_id}/screenshot`, { method: "GET", headers: { Accept: "image/png" }, redirect: "error" });
         if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== "image/png")
            throw new Error(`GUI workspace screenshot failed (${response.status})`);
         const bytes = new Uint8Array(await response.arrayBuffer());
         if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71)
            throw new Error("GUI workspace screenshot was not a PNG");
         return {
            content: [
               { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
               { type: "text", text: `GUI workspace screenshot (${bytes.length} bytes)` },
            ],
         };
      },
   );

   register(
      "gui_workspace_input",
      "write",
      Type.Object({ workspace_id: workspaceId, input }, { additionalProperties: false }),
      async (toolCallId, params, _signal, _onUpdate, ctx) => {
         await jsonRequest(`/${params.workspace_id}/input`, "POST", toolCallId, ctx, params.input, workspaceCapability(params.workspace_id));
         return textResult({ accepted: true, kind: params.input.type });
      },
   );
}
