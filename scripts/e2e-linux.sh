#!/usr/bin/env bash
# Only the Linux end-to-end tests, in the same Docker image as ci-linux.sh (CI runs this on x64).
source "$(dirname "$0")/lib/linux-common.sh"
linux_init "$@"
linux_build_image
step "Linux $linux_arch e2e" linux_workspace e2e
