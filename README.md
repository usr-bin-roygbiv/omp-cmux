# omp-cmux

An [Oh My Pi (OMP)](https://omp.sh) marketplace plugin that exposes cmux through typed tools and keeps cmux synchronized with OMP lifecycle, todo, and subagent activity.

## Prerequisites

- OMP 14.7.3 through 17.x
- Bun (for development and tests)
- cmux installed and running, with its CLI available on `PATH`
- OMP launched inside the target cmux surface so `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` identify the exact destination

Lifecycle mutations never fall back to the focused workspace. If either target ID is unavailable, restore the cmux-provided environment rather than targeting an unrelated workspace.

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

cmux status follows OMP through `idle`, `working`, `thinking`, `tool`, `needs-input`, `retrying`, `compacting`, `waiting`, `done`, `error`, and `stopped`. Tool status includes the active tool name. Todo results mirror phase and item progress, while active task subagents appear by agent name and activity.

The plugin notifies only when:

1. OMP's `ask` tool requests an explicit decision; or
2. a turn is fully complete, with no pending messages and no live or queued subagents.

Completion after `agent_end` is deferred until the final subagent exits. Errors, routine status changes, and intermediate agent endings do not notify. The entrypoint sets `CMUX_OMP_HOOKS_DISABLED=1` before registration to prevent duplicate notifications from legacy hooks.

## Configuration

The manifest exposes these non-secret environment overrides:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CMUX_OMP_BINARY` | `cmux` | Executable name or path |
| `CMUX_OMP_TIMEOUT_MS` | `15000` | Child-process timeout in milliseconds |
| `CMUX_OMP_MAX_OUTPUT_BYTES` | `1048576` | Maximum captured bytes for each output stream |

cmux supplies routing and socket variables for its sessions. The plugin forwards only an allowlist of safe process variables plus the cmux routing/socket variables to direct cmux children; socket credentials are never forwarded to unrelated processes.

## Privacy and remote troubleshooting

The repository contains no telemetry and the plugin does not add any network service. Tool arguments and results remain subject to OMP's own session-storage policy and to whatever the requested cmux operation does. Unrelated environment variables and secrets are not inherited by cmux children.

For remote or nested sessions:

1. Run `omp plugin doctor` and `omp plugin list`.
2. Confirm that the cmux executable is reachable and that both target ID variables are **set**; do not paste their values.
3. Confirm that the trusted transport preserves the cmux socket variables. Never post socket paths or passwords in logs or support requests.
4. Increase `CMUX_OMP_TIMEOUT_MS` only for a known slow connection. Keep the output limit bounded.

Report versions, tool error categories, and whether required variables are set—not hostnames, local paths, IDs, socket values, tokens, or captured workspace content.

## Develop and test

```sh
bun install
bun run typecheck
bun test
```

The default tests use mocked processes and do not require a live cmux instance.

For local OMP development, link the source plugin:

```sh
omp plugin link ./plugins/cmux
```

## Publish

This marketplace is distributed from source; it is not an npm release and has no generated artifacts. To publish a release, update the matching versions in the root package, plugin package, and marketplace catalog, run the checks above, then create and push the corresponding Git tag to the public repository. Consumers receive it with the marketplace update and plugin upgrade commands shown above.

## License

[MIT](LICENSE)
