# Host macOS privacy permissions (TCC)

How local-mac's macOS privacy grants are configured so that any agent running inside cmux can reach local machine data (iMessage, Mail, calendars, contacts, files) now and in the future.

## Model

- macOS TCC (Transparency, Consent, Control) attributes every privacy grant to the **responsible process**. Every shell, agent, and tool launched inside cmux on local-mac is attributed to the cmux app itself: `com.cmuxterm.app` at `/Applications/cmux.app`.
- Therefore exactly one grant on the cmux app covers all current and future agents running inside it. There is nothing to grant per agent, per session, or per workspace.
- TCC state is per host and per user. This doc covers local-mac only; linux-host and autoresearch-client are Linux (no TCC), and remote-mac-1 maintains its own grant state.

## Granted state on local-mac

Verified 2026-07-31 from inside a cmux terminal (Darwin 25.1):

- **Full Disk Access** — granted 2026-07-31. This is the enabling grant for iMessage (`~/Library/Messages/chat.db`), Mail, Safari data, the TCC database itself, and every other TCC-protected file location. It is the single grant that covers "anything else on the machine agents may need in the future" at the file level.
- Pre-existing user-approved grants observed in the TCC database: Contacts, Calendars (limited), Reminders, Camera, Microphone, Bluetooth, Media Library, File Provider, Desktop/Documents/Downloads folder access, Network Volumes, and per-target Apple Events (automation) consents.
- On-demand prompts: most remaining services (Apple Events to a new target app, and similar) prompt automatically on first use. Approve only when the requesting flow is the expected one.

## Intentionally NOT granted

- **Accessibility** and **Screen Recording**: fleet policy routes all visible HID/screen work to `remote-mac-1`/JetKVM. Granting these to cmux on local-mac would undercut the hard local-input safety invariant in the root guide. Do not grant them locally.
- **App Management** (`kTCCServiceSystemPolicyAppBundles`): observed denied since 2026-07-23. Agents do not need to modify other apps' bundles.

## Operational rules

- There is no supported programmatic path to grant TCC permissions without an MDM profile. Granting is a one-time user toggle in System Settings. Agents MUST NOT drive the local UI to click it (hard local-input invariant on local-mac); open the pane for the user and let them toggle:
  `open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"`
- cmux.app is ad-hoc signed (no Developer Team ID), and TCC anchors grants to the code signature. cmux auto-updates (observed pattern: `cmux-<version>.backup.app` rotation in `/Applications`) may invalidate grants. Re-run the verification below after any cmux update and re-grant if access regressed.
- The 2026-07-31 Full Disk Access grant took effect for new child processes without a cmux restart. If a future grant does not take effect, restart cmux and re-verify.
- Notably, after the grant no `kTCCServiceSystemPolicyAllFiles` row appeared in the user TCC database dump even though Full-Disk-Access-gated reads succeeded. Treat the functional verification below, not the TCC row listing, as the source of truth on macOS 26.

## Verification

Run from inside a cmux terminal on local-mac:

```bash
# Full Disk Access proof: succeeds only with FDA granted
sqlite3 "$HOME/Library/Messages/chat.db" "SELECT count(*) FROM message;"

# Grant inventory for the cmux app (auth_value: 0=denied, 2=allowed, other=limited/session variants)
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT service, auth_value FROM access WHERE client='com.cmuxterm.app' ORDER BY service;"
```

The first query failing with `authorization denied` means the cmux responsible process lacks Full Disk Access; re-grant per the operational rules above.

## Related

- iMessage/SMS OTP retrieval authorization and non-HID constraints: root `AGENTS.md` (`iMessage/SMS OTP` bullet). Full Disk Access on cmux is the enabling grant for those programmatic chat.db reads.
- Credential handling for values surfaced through iMessage or any local store: `docs/secrets-platform.md`.
- Local-input safety invariant and remote-mac-1/JetKVM routing for visible HID/screen work: root `AGENTS.md` and `docs/agent-architecture.md`.
