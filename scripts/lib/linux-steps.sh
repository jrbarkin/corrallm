#!/usr/bin/env bash
# Shared failure reporting, also copied into the clean package-test containers.
set -Eeuo pipefail
LINUX_STEP=initialization
trap 'code=$?; printf "FAILED: %s (exit %s, %s:%s)\n" "$LINUX_STEP" "$code" "${BASH_SOURCE[0]}" "$LINENO" >&2; exit "$code"' ERR

step() {
  LINUX_STEP=$1
  shift
  printf '\n--- %s\n' "$LINUX_STEP"
  "$@"
}

die() {
  printf 'FAILED: %s: %s\n' "$LINUX_STEP" "$*" >&2
  exit 1
}
