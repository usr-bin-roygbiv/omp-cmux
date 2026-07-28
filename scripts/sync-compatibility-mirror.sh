#!/usr/bin/env bash
set -euo pipefail

mirror_remote="${1:-compatibility}"

if ! git remote get-url "$mirror_remote" >/dev/null 2>&1; then
	printf 'error: Git remote %q is not configured\n' "$mirror_remote" >&2
	exit 2
fi

git fetch --force --tags origin main
git update-ref refs/remotes/origin/main FETCH_HEAD

mirror_ref="refs/remotes/${mirror_remote}/main"
if git ls-remote --exit-code --heads "$mirror_remote" refs/heads/main >/dev/null 2>&1; then
	git fetch --force "$mirror_remote" "refs/heads/main:${mirror_ref}"
	if ! git merge-base --is-ancestor "$mirror_ref" refs/remotes/origin/main; then
		printf 'error: mirror main has diverged from public main; refusing to overwrite it\n' >&2
		exit 3
	fi
fi

git push --atomic --follow-tags "$mirror_remote" refs/remotes/origin/main:refs/heads/main
