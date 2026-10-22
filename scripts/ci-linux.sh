#!/usr/bin/env bash
# Full local Linux CI in Docker. Defaults to arm64 (native on Apple Silicon).
# x64 uses linux/amd64 emulation on Apple Silicon (Rosetta when enabled); expect a slow run.
# No host Node needed. Uses the same image, caches and non-root working-tree copy as check-linux.
source "$(dirname "$0")/lib/linux-common.sh"
linux_init "$@"
linux_build_image
printf 'Playwright output stays in Docker volumes %s-results and %s-report.\n' "$linux_image" "$linux_image"
step "Linux $linux_arch full CI" linux_workspace ci
