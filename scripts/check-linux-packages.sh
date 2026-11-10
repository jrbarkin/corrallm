#!/usr/bin/env bash
# Build installers, then test installations in fresh Debian bookworm, Ubuntu 24.04 and Fedora 44
# containers. Defaults to arm64. x64 uses slow linux/amd64 emulation on Apple Silicon.
#   check-linux-packages.sh [arm64|x64] [--out <folder>]
# --out keeps the exact installers that were installed and checked in <folder>, under the names
# Forge gave them (a release publishes these bytes). Without it nothing is kept.
# Runtime containers receive only installers and the check scripts, never the build image/Node.
source "$(dirname "$0")/lib/linux-common.sh"
out=
args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = --out ]; then
    [ "$#" -ge 2 ] && [ -z "$out" ] || { printf 'Usage: %s [arm64|x64] [--out <folder>]\n' "$0" >&2; exit 2; }
    out=$2
    shift
  else
    args+=("$1")
  fi
  shift
done
linux_init ${args[@]+"${args[@]}"}
if [ -n "$out" ]; then
  mkdir -p -- "$out"
  out=$(cd -- "$out" && pwd -P)
fi
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
for distro in debian:bookworm ubuntu:24.04 fedora:44; do
  step "Installed package checks ($distro, $linux_arch)" docker run --rm "${linux_docker[@]}" \
    --env CORRALLM_NO_UPDATE_CHECK=1 --volume "$artifacts:/checks:ro" \
    "$distro" bash /checks/linux-installed.sh "$distro" "$linux_arch"
done
if [ -n "$out" ]; then
  step "Keep the checked installers in $out" docker run --rm --platform "$linux_platform" \
    --volume "$artifacts:/checks:ro" --volume "$out:/out" \
    debian:bookworm bash /checks/linux-keep.sh /checks /out
fi
printf '\nLinux %s: deb and rpm installations passed.\n' "$linux_arch"
