# cmux fleet configuration and version lock

`.omp/cmux-fleet/fleet-lock.json` is the Git-backed cmux control plane. It records the exact npm package closure, per-platform native packages, per-machine GUI or TUI build, managed config profile, observed drift, and promotion policy. It complements `.pi/pi-dependency-lock.json`; it does not replace the OMP runtime lock.

## Fleet layout

| Host | Surface | Desired pin | Managed profile | Current state observed 2026-08-02 |
|---|---|---|---|---|
| `local-mac` | macOS GUI, arm64 | app `0.64.20`, build `100`, commit `69f7a8b92`, SHA-256 `3890b42c64ee17e8daf6575168b2aef289304dec63bdb4304d3e44c98d3edd6e` | common macOS settings plus Gemini OMP dock control | matched |
| `remote-mac-1` | remote macOS browser/HID target, arm64 | app `0.64.20`, build `100`, commit `14e3400b9`, SHA-256 `27cbe25464cd891b3cf433f5a16629bbf836e891beadc49fb53a331db8a8617a` | common macOS settings | matched |
| `remote-mac-2` | secondary remote macOS, arm64 | remote-Mac baseline app `0.64.20`, build `100`, commit `14e3400b9`, same pinned SHA-256 | common macOS settings | app absent; do not claim installed |
| `remote-mac-3` | third auxiliary remote macOS browser executor, arm64 | remote-Mac baseline app `0.64.20`, build `100`, commit `14e3400b9`, same pinned SHA-256 | common macOS settings | unverified; do not claim installed |
| `linux-host` | Linux central cmux TUI host, x64 | npm `cmux-tui-linux-x64@0.9.9` with lock integrity | tracked client and central-browser server configs | observed binary is `cmux-tui 0.1.0`, commit `ce84b6ffa0bc135adb5d5e6b520068b244c974c2`, SHA-256 `25a864a1cab5e988a2a5a2bd46a2ad2c61f8763d7f3f67fcf8fc6ee45e5b9a69`; drift is recorded, not silently accepted as the package pin |
| `autoresearch-host` | Linux autoresearch cmux TUI client, x64 | image package `cmux-tui-linux-x64@0.9.9` | tracked autoresearch-client client config | desired image pin recorded; live binary reachability remains unverified |

The same `0.9.9` closure pins `cmux`, `cmux-tui-darwin-arm64`, `cmux-tui-darwin-x64`, `cmux-tui-linux-arm64`, and `cmux-tui-linux-x64` with their npm integrity values. The autoresearch-client Dockerfile consumes the same version. A version bump must update the Pi dependency lock, fleet lock, Dockerfile, relevant package integrities, behavior tests, and host observations together.

The macOS GUI commits differ despite sharing version and build numbers. The SHA-256 and commit are therefore per-host pins; version/build alone are insufficient proof.

## Managed source files

| Source | Purpose |
|---|---|
| `.omp/cmux-fleet/fleet-lock.json` | Package and host pin authority |
| `.omp/cmux-fleet/macos/cmux-managed.json` | Sanitized common macOS automation, browser, notification, sidebar, shortcut, and terminal settings |
| `config/macos/dock-managed.json` | Local-mac Gemini OMP dock control |
| `.omp/cmux-tui/client.json` | Linux client profile |
| `.omp/cmux-tui/linux-host-server.json` | Linux-host central-browser host profile |
| `.omp/cmux-tui/autoresearch-client-client.json` | autoresearch-client isolated client profile |
| `.omp/autoresearch-client-workspace-runtime/Dockerfile` | autoresearch-client image package pin |

Managed files contain no session IDs, resume signatures, cookies, browser profiles, credentials, dynamic workspace state, or secret values.

## macOS materialization

Use the merge-preserving installer only after the owning change is merged to `agent-fleet` `main` and the live root resolves to that revision:

```bash
scripts/install-cmux-fleet-config.py --host local-mac --dry-run
scripts/install-cmux-fleet-config.py --host local-mac
/Applications/cmux.app/Contents/Resources/bin/cmux reload-config
```

For a remote Mac, run the same script from that machine's refreshed `agent-fleet/workspace-root` with the exact host key:

```bash
scripts/install-cmux-fleet-config.py --host remote-mac-1 --dry-run
scripts/install-cmux-fleet-config.py --host remote-mac-1
```

Do not run the `remote-mac-2` install path until the pinned app exists and its Info.plist and binary SHA-256 match the host lock.

The installer:

- accepts JSON and JSONC input
- recursively overwrites only tracked managed keys
- preserves unknown operator keys, actions, and dynamic `terminal.resumeCommands`
- merges dock controls by stable `id` instead of deleting unrelated controls
- stages complete output before writing
- performs atomic replacements
- refuses concurrent target changes
- is idempotent

Comments in a JSONC input are not part of the semantic configuration and may be removed when the merged JSON is written. Unknown values remain.

The existing `install-cmux-linux-host-default.py` still owns the `linux-host-default` action and launcher. The fleet installer deliberately does not overwrite `actions` or `ui.newWorkspace`; both installers can therefore operate without competing representations.

## Linux materialization

Use the existing role-specific installer:

```bash
scripts/install-cmux-tui-config.sh client --dry-run
scripts/install-cmux-tui-config.sh client
scripts/install-cmux-tui-config.sh server --dry-run
scripts/install-cmux-tui-config.sh server
```

Run `server` only on `linux-host`. autoresearch-client receives `.omp/cmux-tui/autoresearch-client-client.json` through its GitOps-managed image bootstrap. Do not replace image publication or host configuration with an ad hoc download.

Linux-host's observed native `0.1.0` build does not match the `0.9.9` npm package representation. Keep the discrepancy explicit until an owned migration proves protocol and browser compatibility and changes the desired pin or replaces the binary. Do not relabel it matched based only on functional behavior.

## Verification

For every revision:

1. Parse `.omp/cmux-fleet/fleet-lock.json` and match the package closure to `.pi/pi-dependency-lock.json`.
2. Match the autoresearch-client Dockerfile version to the same closure.
3. Verify every managed profile path exists.
4. Exercise the macOS installer against existing JSONC with unrelated operator state and prove an idempotent second run.
5. Run the tracked agent-fleet pre-commit and pre-push hooks.
6. Run an owned cmux interactive smoke in the caller-captured workspace; do not create another workspace.
7. On each refreshed host, compare the app Info.plist or `cmux-tui --version` plus binary SHA-256 to its host lock.
8. Record absent or unreachable machines as absent or unverified, never matched.

Current macOS binary proof uses `/Applications/cmux.app/Contents/Info.plist` for version, build, and commit, and `/Applications/cmux.app/Contents/MacOS/cmux` for SHA-256. Linux proof uses the installed `cmux-tui` binary.

## Promotion and rollback

1. Change the lock, managed configs, installer, tests, and docs on an `agent-fleet` feature branch.
2. Pass the tracked local hooks and owned cmux smoke.
3. Merge to `main`.
4. Refresh the Git-backed root on each intended host.
5. Dry-run the installer, review changed paths, install, reload, and smoke.

Rollback is Git-first: revert the owning commit, refresh each host, rerun the appropriate installer, and reload cmux. Stop or restart only a process or surface owned by the current validation. Never alter an unrelated OMP root, cmux workspace, browser surface, or remote user session.
