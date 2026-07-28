# omp-cmux

An [Oh My Pi (OMP)](https://omp.sh) marketplace plugin that exposes cmux through typed tools and keeps cmux synchronized with OMP lifecycle, todo, and subagent activity.

## Prerequisites

- OMP 17.1.3 or newer for the public Git installation flow
- Bun (for development and tests)
- cmux GUI or `cmux-tui` protocol 12 or newer installed and running, with its CLI available on `PATH`
- OMP launched inside the target backend:
  - GUI cmux supplies `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`.
  - cmux TUI supplies `CMUX_TUI_SOCKET`; a numeric `CMUX_TUI_SURFACE_ID` remains the preferred exact target. When the surface ID is omitted, the plugin recovers it only when exactly one registered surface process is the current OMP process or its direct parent.

Lifecycle mutations never fall back to focused state. The plugin selects cmux TUI whenever `CMUX_TUI_SOCKET` is present. On Darwin, complete GUI workspace and surface identities force `/Applications/cmux.app/Contents/Resources/bin/cmux`, even when the process inherited a stale `CMUX_OMP_BINARY` pointing at npm `cmux-tui`. Missing GUI IDs and missing, invalid, stale, or ambiguous TUI process ownership fail closed.

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

The plugin detects one backend for every tool call. `CMUX_TUI_SOCKET` selects TUI before any GUI variables; GUI requires both `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`; incomplete and unavailable routes fail closed.

Five typed tools cover common operations with exact targets:

- `cmux_workspace` — list, create, close, and rename workspaces in both backends, plus the complete GUI workspace action set.
- `cmux_surface` — create, split, inspect, read, control, resume, and close GUI surfaces; TUI maps its supported subset to `list-workspaces`, `new-tab`, `split`, `read-screen`, `read-scrollback`, `send`, `send-key`, and `close-surface`.
- `cmux_browser` — complete GUI WKWebView command coverage and exact TUI browser-tab creation through `new-browser-tab`. TUI does not expose GUI selector/DOM automation.
- `cmux_notification` — native notifications in both backends; GUI additionally supports listing, dismissal, read state, opening, jumping, and clearing.
- `cmux_sidebar` — GUI status, progress, logs, custom sidebars, and right-sidebar visibility. TUI sidebar plugins remain available through the raw CLI.

Three escape hatches preserve access to the complete, evolving source contracts:

- `cmux_capabilities` runs GUI capability discovery or TUI `--json identify`, then returns the detected backend and source-derived GUI command or TUI CLI/protocol inventories.
- `cmux_rpc` invokes arbitrary GUI JSON-RPC methods. It rejects TUI calls before execution because the TUI has no JSON-RPC endpoint.
- `cmux_cli` runs an explicit argument vector against the detected backend binary without a shell. It covers every source-listed GUI command and every TUI CLI verb, including future commands before a typed mapping exists.

Each tool returns readable content plus structured details. Failures are reported as tool errors, cancellation stops the child process, and captured output is bounded.

Typed operations also encode native contracts that are easy to misapply through raw CLI calls:

- Mutations never resolve a focused workspace, pane, or surface. GUI uses explicit or injected workspace and surface IDs; TUI requires numeric workspace, pane, or surface IDs as appropriate.
- `cmux_surface read` retries only the exact transient `Failed to read terminal text` GUI startup race, with a bounded delay window.
- Browser surfaces are created through `cmux_browser open` or `new`; GUI `cmux_surface create` rejects `type: browser`, while TUI browser creation requires an explicit `--pane` argument.
- `cmux_surface send_key` normalizes common aliases such as `CTRL_B`, `C-b`, `CTRL_C`, `ESC`, `ENTER`, and `LEFT` to native positional key names.
- Successful GUI typed closes report the requested workspace and surface rather than cmux's newly selected neighboring surface.
- Targeted GUI browser actions validate both exact identities but pass the native leading `--surface` flag. Use `snapshot` and a returned ref or standard CSS; Playwright `:has-text` selectors and WKWebView `network`/`input_mouse` actions remain unsupported even though the upstream command registry exposes their names.

Prefer typed tools. For unavoidable GUI `cmux_cli` calls, use top-level `read-screen`, `close-surface`, and `list-panels`, plus positional `send-key KEY`. Do not invent `surface read`, `surface close`, `list-surfaces`, `--key`, or a command string without an argv array. Native `open` expects a local path rather than a `file://` URL; use browser navigation for URLs. TUI syntax is a separate, versioned CLI contract.

## Lifecycle synchronization

GUI cmux status follows OMP through `idle`, `working`, `thinking`, `tool`, `needs-input`, `retrying`, `compacting`, `waiting`, `done`, `error`, and `stopped`. Tool status includes the active tool name. Ask gates publish `Needs input`, flash the originating surface, and only then send the decision notification; resolving the matching Ask restores the derived lifecycle status. Todo results mirror phase and item progress, while active task subagents appear by agent name and activity.

In cmux TUI, lifecycle state is sent through the protocol 12 `cmux-tui report-agent` schema to the numeric injected surface. The plugin reports exactly one root record labeled `OMP`, including session state, lifecycle detail, elapsed start time, todo progress, running jobs, and the active-agent total. Subagent activity is folded into that root record's detail and `agents_active` field; it never creates another agent record or native notification.

Native backend notifications are emitted for:

1. an `ask` tool request;
2. a tool-approval request;
3. a successful `xd://propose` plan submission; and
4. the final `session_stop`, classified as completion, input required, blocked, or error.

Both native paths receive the same semantic subtitle: `Waiting`, `Permission`, `Plan Ready`, `Completed`, `Blocked`, or `Error`. cmux TUI subtitle and agent-telemetry support require protocol 12.

Each `before_agent_start` result appends a compact `<runtime-environment>` system-prompt block with the current machine and `cmux GUI`, `cmux TUI`, or `headless agent under ...` interface. The block is replaced rather than duplicated on later turns. Lifecycle effects remain root/UI-only: subagents and headless sessions receive environment awareness without producing statuses or notifications. Each semantic event is deduplicated by its stable session/tool-call or session/turn identity. Aborted turns and stops already owned by another stop hook are suppressed. A root interactive session inside remote tmux without a cmux surface retains the session-entry notification fallback. The entrypoint sets `CMUX_OMP_HOOKS_DISABLED=1` before registration to prevent duplicate legacy hooks.

Package loading may finish after OMP has already emitted `session_start`, so the first `before_agent_start` event also activates and resets lifecycle state. Final status is settled authoritatively from `session_stop`; completion, input, blocked, error, and aborted outcomes therefore cannot leave cmux stuck on `Thinking` when `agent_end` is missing or delayed.

## Configuration

The manifest exposes these non-secret environment overrides:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CMUX_OMP_BINARY` | `cmux` | Executable name or path outside a complete Darwin GUI session; complete Darwin GUI identities select the native app CLI |
| `CMUX_OMP_TUI_BINARY` | `cmux-tui` | cmux TUI executable name or path |
| `CMUX_OMP_TIMEOUT_MS` | `15000` | Child-process timeout in milliseconds |
| `CMUX_OMP_MAX_OUTPUT_BYTES` | `1048576` | Maximum captured bytes for each output stream |

cmux supplies routing and socket variables for its sessions. The plugin forwards only an allowlist of safe process variables plus the GUI or TUI routing/socket variables to direct children; socket credentials are never forwarded to unrelated processes.

## Privacy and remote troubleshooting

The repository contains no telemetry and the plugin does not add any network service. Tool arguments and results remain subject to OMP's own session-storage policy and to whatever the requested cmux operation does. Unrelated environment variables and secrets are not inherited by cmux children.

For remote or nested sessions:

1. Run `omp plugin doctor` and `omp plugin list`.
2. Confirm that the correct executable is reachable and that the selected backend's routing variables are **set**; do not paste their values.
3. For GUI, preserve both GUI target IDs. For TUI, preserve `CMUX_TUI_SOCKET`; preserve the numeric TUI surface ID when it is available, otherwise confirm that OMP is the surface process or its direct child. Never post socket paths or passwords in logs or support requests.
4. Increase `CMUX_OMP_TIMEOUT_MS` only for a known slow connection. Keep the output limit bounded.

Report versions, tool error categories, and whether required variables are set—not hostnames, local paths, IDs, socket values, tokens, or captured workspace content.

## Develop and test

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

The default tests use mocked processes and do not require a live cmux instance. Woodpecker runs the same frozen OMP contract and a second lane that installs the latest OMP release, on pushes, pull requests, manual runs, and the configured compatibility cron schedule.

Live helpers are opt-in and never run in the default suite. Launch OMP inside the destination backend, then run only the matching helper:

```sh
# Read-only GUI or TUI tool discovery
CMUX_INTEGRATION=1 bun test tests/integration/cmux.live.test.ts

# Owned TUI workspace action smoke; creates, exercises, and removes its own workspace
CMUX_TUI_ACTIONS_INTEGRATION=1 bun test tests/integration/tui-actions.live.test.ts

# GUI lifecycle (requires complete GUI workspace and surface identities)
CMUX_LIFECYCLE_INTEGRATION=1 bun test tests/integration/lifecycle.live.test.ts

# TUI lifecycle (requires a TUI socket and numeric surface identity)
CMUX_TUI_LIFECYCLE_INTEGRATION=1 bun test tests/integration/tui-lifecycle.live.test.ts
```

The TUI action smoke restores the previously active workspace and closes only resources whose generated smoke name it owns.

For local OMP development, link the repository root:

```sh
omp plugin link .
```

The repository root is the same extension package used by direct Git installs. Linking `./plugins/cmux` beside an installed root package would activate the lifecycle adapter twice, duplicating every status update and notification.

## Publish

This marketplace is distributed from source; it is not an npm release and has no generated artifacts. To publish a release, update the matching versions in the root package, plugin package, and marketplace catalog, run the checks above, then create and push the corresponding Git tag to the public repository. Consumers receive it with the marketplace update and plugin upgrade commands shown above.

Maintainers who feed a private compatibility runner can configure a Git remote for it and run `scripts/sync-compatibility-mirror.sh <remote>`. The script fetches public `origin/main` and release tags, permits only a fast-forward of mirror `main`, pushes the branch and reachable annotated tags atomically, and refuses to overwrite divergence. Scheduled compatibility runs fetch public `main` before testing, so their locked and latest OMP lanes always exercise the current public source even between mirror synchronizations.

## License

[MIT](LICENSE)
