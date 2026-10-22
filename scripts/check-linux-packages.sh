#!/usr/bin/env bash
# Build installers, then test installations in fresh Debian bookworm and Fedora 44 containers.
# Defaults to arm64. x64 uses slow linux/amd64 emulation on Apple Silicon.
# Runtime containers receive only installers and the check scripts, never the build image/Node.
source "$(dirname "$0")/lib/linux-common.sh"
linux_init "$@"
linux_build_image
artifacts=$linux_image-packages-$$
cleanup() {
  local code=$?
  if ! docker volume rm "$artifacts"; then
    printf 'FAILED: remove artifact volume %s\n' "$artifacts" >&2
    [ "$code" -ne 0 ] || code=1
  fi
  exit "$code"
}
step 'Create temporary artifact volume' docker volume create "$artifacts"
trap cleanup EXIT
step 'Give build user the artifact volume' docker run --rm --platform "$linux_platform" \
  --user root --volume "$artifacts:/artifacts" "$linux_image" chown node:node /artifacts
step "Build Linux $linux_arch installers" linux_workspace packages "$artifacts"
for distro in debian:bookworm fedora:44; do
  step "Installed package checks ($distro, $linux_arch)" docker run --rm "${linux_docker[@]}" \
    --env CORRALLM_NO_UPDATE_CHECK=1 --volume "$artifacts:/checks:ro" \
    "$distro" bash /checks/linux-installed.sh "$distro" "$linux_arch"
done
printf '\nLinux %s: deb and rpm installations passed.\n' "$linux_arch"
