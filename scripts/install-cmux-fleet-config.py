#!/usr/bin/env python3
"""Merge tracked cmux settings into a fleet Mac without deleting operator state."""

from __future__ import annotations

import argparse
import copy
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOCK = ROOT / ".omp" / "cmux-fleet" / "fleet-lock.json"
DEFAULT_CONFIG = Path.home() / ".config" / "cmux" / "cmux.json"
DEFAULT_DOCK_CONFIG = Path.home() / ".config" / "cmux" / "dock.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--dock-config", type=Path, default=DEFAULT_DOCK_CONFIG)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def strip_jsonc(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    line_comment = False
    block_comment = False
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
                output.append(char)
            index += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                if char == "\n":
                    output.append(char)
                index += 1
            continue
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == "/" and following == "/":
            line_comment = True
            index += 2
            continue
        if char == "/" and following == "*":
            block_comment = True
            index += 2
            continue
        output.append(char)
        index += 1

    uncommented = "".join(output)
    output = []
    index = 0
    in_string = False
    escaped = False
    while index < len(uncommented):
        char = uncommented[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == ",":
            lookahead = index + 1
            while lookahead < len(uncommented) and uncommented[lookahead].isspace():
                lookahead += 1
            if lookahead < len(uncommented) and uncommented[lookahead] in "]}":
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"refusing to rewrite invalid cmux JSON/JSONC {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"cmux configuration must contain a JSON object: {path}")
    return value


def merge_controls(existing: list[Any], managed: list[Any]) -> list[Any]:
    result = copy.deepcopy(existing)
    positions = {
        item.get("id"): index
        for index, item in enumerate(result)
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for control in managed:
        if not isinstance(control, dict) or not isinstance(control.get("id"), str):
            raise SystemExit("managed dock controls require string id fields")
        identifier = control["id"]
        if identifier in positions:
            result[positions[identifier]] = copy.deepcopy(control)
        else:
            positions[identifier] = len(result)
            result.append(copy.deepcopy(control))
    return result


def merge_managed(existing: Any, managed: Any, key: str = "") -> Any:
    if isinstance(existing, dict) and isinstance(managed, dict):
        result = copy.deepcopy(existing)
        for child_key, child_value in managed.items():
            result[child_key] = merge_managed(result.get(child_key), child_value, child_key)
        return result
    if key == "controls" and isinstance(existing, list) and isinstance(managed, list):
        return merge_controls(existing, managed)
    return copy.deepcopy(managed)


def rendered(existing: dict[str, Any], source: dict[str, Any]) -> bytes:
    return (json.dumps(merge_managed(existing, source), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def atomic_replace(path: Path, expected: bytes, updated: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else b""
    if current != expected:
        raise SystemExit(f"target changed concurrently; refusing to overwrite {path}")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def tracked_source(relative: str) -> dict[str, Any]:
    path = (ROOT / relative).resolve()
    try:
        path.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise SystemExit(f"managed cmux source escapes workspace root: {relative}") from exc
    return load_object(path)


def main() -> int:
    args = parse_args()
    lock = load_object(args.lock)
    hosts = lock.get("hosts")
    profiles = lock.get("managedProfiles")
    if not isinstance(hosts, dict) or not isinstance(profiles, dict):
        raise SystemExit("cmux fleet lock is missing hosts or managedProfiles")
    host = hosts.get(args.host)
    if not isinstance(host, dict):
        raise SystemExit(f"unknown cmux fleet host: {args.host}")
    profile_name = host.get("profile")
    profile = profiles.get(profile_name)
    if not isinstance(profile_name, str) or not isinstance(profile, dict) or not isinstance(profile.get("cmux"), str):
        raise SystemExit(f"host {args.host} has no managed macOS cmux profile")

    targets: list[tuple[Path, dict[str, Any]]] = [(args.config.expanduser(), tracked_source(profile["cmux"]))]
    if isinstance(profile.get("dock"), str):
        targets.append((args.dock_config.expanduser(), tracked_source(profile["dock"])))

    changes: list[tuple[Path, bytes, bytes]] = []
    for target, source in targets:
        original = target.read_bytes() if target.exists() else b""
        updated = rendered(load_object(target), source)
        changes.append((target, original, updated))

    if args.dry_run:
        changed = [str(target) for target, original, updated in changes if original != updated]
        print(json.dumps({"host": args.host, "changed": changed, "dry_run": True}, sort_keys=True))
        return 0

    for target, original, updated in changes:
        if original != updated:
            atomic_replace(target, original, updated)
    print(json.dumps({
        "host": args.host,
        "changed": [str(target) for target, original, updated in changes if original != updated],
        "verified": [str(target) for target, _, _ in changes],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
