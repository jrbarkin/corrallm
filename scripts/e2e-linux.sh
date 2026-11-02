#!/usr/bin/env bash
# Only the Linux end-to-end tests, in the same Docker image as ci-linux.sh (CI runs this on x64).
source "$(dirname "$0")/lib/linux-common.sh"
arch=${1:-arm64}
if [ "$#" -gt 0 ]; then shift; fi
linux_init "$arch"
linux_build_image
step "Linux $linux_arch e2e container" linux_workspace e2e '' "$@"
