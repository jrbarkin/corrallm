#!/usr/bin/env bash
# Fast packaged Linux smoke test in Docker: native self-tests and refused launch switches.
# Defaults to arm64 (native on Apple Silicon); x64 uses slow linux/amd64 emulation there.
# The shared image and pnpm/Electron caches are retained, never host node_modules or .env.
source "$(dirname "$0")/lib/linux-common.sh"
linux_init "$@"
linux_build_image
step "Linux $linux_arch packaged smoke test" linux_workspace smoke
