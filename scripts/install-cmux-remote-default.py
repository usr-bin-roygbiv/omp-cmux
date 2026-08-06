#!/usr/bin/env python3
"""Install the tracked linux-host-first action into the user's cmux config."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ACTION_SOURCE = ROOT / "config" / "local-mac" / "cmux-linux-host-default-action.json"
DEFAULT_CONFIG = Path.home() / ".config" / "cmux" / "cmux.json"
LAUNCHER_SOURCE = ROOT / "scripts" / "cmux-linux-host-default-shell.sh"
DEFAULT_LAUNCHER_TARGET = Path.home() / ".local" / "bin" / "cmux-linux-host-default-shell"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--launcher-target", type=Path, default=DEFAULT_LAUNCHER_TARGET)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"refusing to rewrite invalid or JSONC cmux config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"cmux config must contain a JSON object: {path}")
    return value


def render_updated(config: dict[str, Any], source: dict[str, Any]) -> bytes:
    action_id = source.get("actionId")
    action = source.get("action")
    if not isinstance(action_id, str) or not action_id or not isinstance(action, dict):
        raise SystemExit(f"invalid tracked action source: {ACTION_SOURCE}")

    actions = config.setdefault("actions", {})
    if not isinstance(actions, dict):
        raise SystemExit("cmux config actions must be an object")
    actions[action_id] = action

    ui = config.setdefault("ui", {})
    if not isinstance(ui, dict):
        raise SystemExit("cmux config ui must be an object")
    new_workspace = ui.setdefault("newWorkspace", {})
    if not isinstance(new_workspace, dict):
        raise SystemExit("cmux config ui.newWorkspace must be an object")
    new_workspace["action"] = action_id

    return (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def atomic_replace(path: Path, expected: bytes, updated: bytes, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else b""
    if current != expected:
        raise SystemExit(f"target changed concurrently; refusing to overwrite {path}")
    mode = mode if mode is not None else (stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    source = load_object(ACTION_SOURCE)
    launcher_target = args.launcher_target.expanduser()
    launcher_bytes = LAUNCHER_SOURCE.read_bytes()
    launcher_original = launcher_target.read_bytes() if launcher_target.exists() else b""
    original = args.config.read_bytes() if args.config.exists() else b""
    config = load_object(args.config)
    updated = render_updated(config, source)
    action_id = source["actionId"]

    if args.dry_run:
        print(f"would install {action_id} into {args.config} and launcher into {launcher_target}")
        return 0

    if launcher_original != launcher_bytes or not os.access(launcher_target, os.X_OK):
        atomic_replace(launcher_target, launcher_original, launcher_bytes, mode=0o755)
    if updated == original:
        print(f"{action_id} already installed in {args.config}; launcher verified at {launcher_target}")
        return 0

    atomic_replace(args.config, original, updated)
    print(f"installed {action_id} into {args.config}; launcher installed at {launcher_target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
