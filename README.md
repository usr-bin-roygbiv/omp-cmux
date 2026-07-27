# omp-cmux

An [Oh My Pi (OMP)](https://omp.sh) marketplace plugin that exposes cmux through typed tools and keeps cmux synchronized with OMP lifecycle, todo, and subagent activity.

## Prerequisites

- OMP 17.1.3 or newer for the public Git installation flow
- Bun (for development and tests)
- cmux GUI or a protocol-11-or-newer `cmux-tui` installed and running, with its CLI available on `PATH`
- OMP launched inside the target backend:
  - GUI cmux supplies `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`.
  - cmux TUI supplies `CMUX_TUI_SOCKET`, a numeric `CMUX_TUI_SURFACE_ID`, and `CMUX_TUI_WORKSPACE_ID`.

Lifecycle mutations never fall back to focused state. The plugin selects cmux TUI whenever `CMUX_TUI_SOCKET` is present and otherwise retains GUI routing. Missing or invalid required IDs fail closed.

## Install

```sh
omp plugin marketplace add usr-bin-roygbiv/omp-cmux
omp plugin install github:usr-bin-roygbiv/omp-cmux
```

The marketplace command publishes the catalog entry; the Git install activates the extension from the same public repository. OMP currently does not load `omp.extensions` entrypoints directly from marketplace caches, so `omp plugin install cmux@omp-cmux` alone only caches the catalog package. Confirm the active installation with `omp plugin list` and `omp plugin doctor`.

To refresh an existing installation:

```sh
omp plugin marketplace update omp-cmux
omp plugin install --force github:usr-bin-roygbiv/omp-cmux
```

## Tools

The plugin registers typed, high-value tools for common operations:

- `cmux_workspace` — workspace actions
- `cmux_surface` — surface actions
- `cmux_browser` — browser actions
- `cmux_notification` — notifications
- `cmux_sidebar` — sidebar state

Three escape hatches preserve access to the complete, evolving cmux API:

- `cmux_capabilities` discovers the capabilities available from the installed cmux version.
- `cmux_rpc` invokes an arbitrary cmux RPC method.
- `cmux_cli` runs a cmux CLI argument vector directly, without a shell.

Each tool returns readable content plus structured details. Failures are reported as tool errors, cancellation stops the child process, and captured output is bounded.

## Lifecycle synchronization

GUI cmux status follows OMP through `idle`, `working`, `thinking`, `tool`, `needs-input`, `retrying`, `compacting`, `waiting`, `done`, `error`, and `stopped`. Tool status includes the active tool name. Ask gates publish `Needs input`, flash the originating surface, and only then send the decision notification; resolving the matching Ask restores the derived lifecycle status. Todo results mirror phase and item progress, while active task subagents appear by agent name and activity.

In cmux TUI, the same lifecycle is sent through `cmux-tui report-agent` to the numeric injected surface. Reports include the session label and detail, start time, completed and total tasks, running async jobs, and the root agent plus live subagents. The plugin reads jobs only through OMP's public `AsyncJobManager` export. A single bounded polling timer refreshes job counts while a turn is active and is cleared at turn stop or session shutdown.

Native backend notifications are emitted for:

1. an `ask` tool request;
2. a tool-approval request;
3. a successful `xd://propose` plan submission; and
4. the final `session_stop`, classified as completion, input required, blocked, or error.

Both native paths receive the same semantic subtitle: `Waiting`, `Permission`, `Plan Ready`, `Completed`, `Blocked`, or `Error`. cmux TUI subtitle support requires protocol 11.

Each semantic event is deduplicated by its stable session/tool-call or session/turn identity. Aborted turns and stops already owned by another stop hook are suppressed. Root/UI gating prevents subagents and headless sessions from producing lifecycle effects. A root interactive session inside remote tmux without a cmux surface retains the session-entry notification fallback. The entrypoint sets `CMUX_OMP_HOOKS_DISABLED=1` before registration to prevent duplicate legacy hooks.

Package loading may finish after OMP has already emitted `session_start`, so the first `before_agent_start` event also activates and resets lifecycle state. Final status is settled authoritatively from `session_stop`; completion, input, blocked, error, and aborted outcomes therefore cannot leave cmux stuck on `Thinking` when `agent_end` is missing or delayed.

## Configuration

The manifest exposes these non-secret environment overrides:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CMUX_OMP_BINARY` | `cmux` | Executable name or path |
| `CMUX_OMP_TUI_BINARY` | `cmux-tui` | cmux TUI executable name or path |
| `CMUX_OMP_TIMEOUT_MS` | `15000` | Child-process timeout in milliseconds |
| `CMUX_OMP_MAX_OUTPUT_BYTES` | `1048576` | Maximum captured bytes for each output stream |

cmux supplies routing and socket variables for its sessions. The plugin forwards only an allowlist of safe process variables plus the GUI or TUI routing/socket variables to direct children; socket credentials are never forwarded to unrelated processes.

## Privacy and remote troubleshooting

The repository contains no telemetry and the plugin does not add any network service. Tool arguments and results remain subject to OMP's own session-storage policy and to whatever the requested cmux operation does. Unrelated environment variables and secrets are not inherited by cmux children.

For remote or nested sessions:

1. Run `omp plugin doctor` and `omp plugin list`.
2. Confirm that the correct executable is reachable and that the selected backend's routing variables are **set**; do not paste their values.
3. For GUI, preserve both GUI target IDs. For TUI, preserve `CMUX_TUI_SOCKET` and the numeric TUI surface ID. Never post socket paths or passwords in logs or support requests.
4. Increase `CMUX_OMP_TIMEOUT_MS` only for a known slow connection. Keep the output limit bounded.

Report versions, tool error categories, and whether required variables are set—not hostnames, local paths, IDs, socket values, tokens, or captured workspace content.

## Develop and test

```sh
bun install
bun run typecheck
bun test
```

The default tests use mocked processes and do not require a live cmux instance.

The live helpers are opt-in and are never run by the default suite. With OMP already launched in the destination backend, run exactly one matching helper:

```sh
# GUI cmux (requires CMUX_WORKSPACE_ID and CMUX_SURFACE_ID)
CMUX_LIFECYCLE_INTEGRATION=1 bun test tests/integration/lifecycle.live.test.ts

# cmux TUI (requires CMUX_TUI_SOCKET and numeric CMUX_TUI_SURFACE_ID)
CMUX_TUI_LIFECYCLE_INTEGRATION=1 bun test tests/integration/tui-lifecycle.live.test.ts
```

For local OMP development, link the repository root:

```sh
omp plugin link .
```

The repository root is the same extension package used by direct Git installs. Linking `./plugins/cmux` beside an installed root package would activate the lifecycle adapter twice, duplicating every status update and notification.

## Publish

This marketplace is distributed from source; it is not an npm release and has no generated artifacts. To publish a release, update the matching versions in the root package, plugin package, and marketplace catalog, run the checks above, then create and push the corresponding Git tag to the public repository. Consumers receive it with the marketplace update and plugin upgrade commands shown above.

## License

[MIT](LICENSE)
