#!/usr/bin/env bash
# What a built app's resources must hold of its notices, sourced by check-macos.sh and
# linux-installed.sh. $1 = the resources folder. Prints what is wrong and returns 1.
SHIPPED_NOTICE_PACKAGES=(react @xterm/xterm @xyflow/react zod @modelcontextprotocol/sdk)

check_shipped_notices() {
  local resources=$1 notices name problems=0
  notices=$resources/THIRD-PARTY-NOTICES.txt
  if [ ! -s "$notices" ]; then
    printf 'No THIRD-PARTY-NOTICES.txt (or it is empty) in %s\n' "$resources" >&2
    return 1
  fi
  for name in "${SHIPPED_NOTICE_PACKAGES[@]}"; do
    # An entry is its "<name> <version>" header, then its "License:" line.
    if ! grep -E -A1 "^$name [0-9]" "$notices" | grep -q '^License: '; then
      printf 'THIRD-PARTY-NOTICES.txt has no entry with a license for %s\n' "$name" >&2
      problems=1
    fi
  done
  if grep -Eq '^(vite |@electron-forge/)' "$notices"; then
    printf 'THIRD-PARTY-NOTICES.txt names a build tool (vite or @electron-forge):\n' >&2
    grep -E '^(vite |@electron-forge/)' "$notices" >&2
    problems=1
  fi
  for name in electron-LICENSE LICENSES.chromium.html; do
    if [ ! -s "$resources/$name" ]; then
      printf 'No %s in %s\n' "$name" "$resources" >&2
      problems=1
    fi
  done
  return "$problems"
}
