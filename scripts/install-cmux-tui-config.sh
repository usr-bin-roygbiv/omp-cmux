#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
readonly root="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
readonly home_dir="${CMUX_TUI_HOME:-${HOME:?HOME is required}}"
readonly hostname_bin="${CMUX_TUI_HOSTNAME_BIN:-/bin/hostname}"
readonly systemctl_bin="${CMUX_TUI_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
readonly client_source="$root/.omp/cmux-tui/client.json"
readonly server_source="$root/.omp/cmux-tui/linux-host-server.json"
readonly service_source="$root/.omp/cmux-tui/cmux-tui-central-browser.service"
readonly chrome_wrapper_source="$root/.omp/cmux-tui/google-chrome-cmux"
readonly config_target="$home_dir/.config/cmux/cmux-tui.json"
readonly service_target="$home_dir/.config/systemd/user/cmux-tui-central-browser.service"
readonly chrome_wrapper_target="$home_dir/.local/libexec/cmux-tui/google-chrome"

dry_run=0
no_start=0
role="${1:-}"
[[ -n "$role" ]] && shift

fail() {
  printf 'cmux-tui config installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s <client|server> [--dry-run] [--no-start]\n' "$0" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --no-start) no_start=1 ;;
    *) usage ;;
  esac
  shift
done

case "$role" in
  client)
    readonly config_source="$client_source"
    no_start=1
    ;;
  server)
    readonly config_source="$server_source"
    [[ -x "$hostname_bin" ]] || fail "hostname executable is unavailable: $hostname_bin"
    actual_host="$($hostname_bin -s 2>/dev/null)" || fail "unable to determine hostname"
    [[ "$actual_host" == linux-host ]] || fail "refusing host $actual_host (expected linux-host)"
    ;;
  *) usage ;;
esac

for source in "$config_source"; do
  [[ -f "$source" && -r "$source" ]] || fail "tracked source is unavailable: $source"
done
if [[ "$role" == server ]]; then
  for source in "$service_source" "$chrome_wrapper_source"; do
    [[ -f "$source" && -r "$source" ]] || fail "tracked source is unavailable: $source"
  done
fi

backup_existing() {
  local destination="$1"
  local backup
  [[ -e "$destination" ]] || return 0
  backup="$(mktemp "${destination}.bak.XXXXXX")" || return 1
  cp -p -- "$destination" "$backup" || {
    rm -f -- "$backup"
    return 1
  }
}

atomic_install() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local parent temporary
  parent="$(dirname -- "$destination")"
  if [[ -L "$parent" || (-e "$parent" && ! -d "$parent") ]]; then
    fail "target parent is not a directory: $parent"
  fi
  if [[ -L "$destination" || (-e "$destination" && ! -f "$destination") ]]; then
    fail "target is not a regular file: $destination"
  fi
  if ((dry_run)); then
    printf 'would install %s -> %s\n' "$source" "$destination"
    return 0
  fi
  install -d -m 0700 -- "$parent"
  if [[ -f "$destination" ]] && cmp -s -- "$source" "$destination"; then
    chmod "$mode" -- "$destination"
    return 0
  fi
  [[ ! -e "$destination" ]] || backup_existing "$destination" || fail "could not preserve prior target: $destination"
  temporary="$(mktemp "${destination}.tmp.XXXXXX")" || fail "could not create temporary target: $destination"
  if ! install -m "$mode" -- "$source" "$temporary" || ! cmp -s -- "$source" "$temporary" || ! mv -f -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    fail "could not atomically install: $destination"
  fi
}

atomic_install "$config_source" "$config_target" 0600
if [[ "$role" == server ]]; then
  atomic_install "$service_source" "$service_target" 0644
  atomic_install "$chrome_wrapper_source" "$chrome_wrapper_target" 0555
  if ((dry_run == 0)); then
    for directory in "$home_dir/.local/state/cmux-tui" "$home_dir/.local/share/cmux-tui" "$home_dir/.cache/cmux-tui"; do
      if [[ -L "$directory" || (-e "$directory" && ! -d "$directory") ]]; then
        fail "runtime path is not a directory: $directory"
      fi
      install -d -m 0700 -- "$directory"
    done
  fi
fi

if [[ "$role" == server && $dry_run -eq 0 && $no_start -eq 0 ]]; then
  [[ -x "$systemctl_bin" ]] || fail "systemctl executable is unavailable: $systemctl_bin"
  "$systemctl_bin" --user daemon-reload
  "$systemctl_bin" --user enable cmux-tui-central-browser.service
  "$systemctl_bin" --user restart cmux-tui-central-browser.service
fi

printf 'cmux-tui config installer: %s configuration %s\n' "$role" "$([[ $dry_run -eq 1 ]] && printf planned || printf installed)"
