#!/usr/bin/env bash
# Host-side Docker setup shared by the smoke, CI and installer gates. No host Node needed.
source "$(dirname "${BASH_SOURCE[0]}")/linux-steps.sh"

linux_init() {
  if [ "$#" -gt 1 ]; then
    printf 'Usage: %s [arm64|x64]\n' "$0" >&2
    exit 2
  fi
  linux_arch=${1:-arm64}
  case "$linux_arch" in
    arm64) linux_platform=linux/arm64 ;;
    x64) linux_platform=linux/amd64 ;;
    *) printf 'Usage: %s [arm64|x64]\n' "$0" >&2; exit 2 ;;
  esac
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  linux_image=corrallm-check-linux-$linux_arch
  linux_docker=(--platform "$linux_platform" --init --shm-size 1g
    --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
  # Docker must allow Chromium's user namespaces. Electron's sandbox remains enabled.
}

linux_build_image() (
  local node_version pnpm_version context
  node_version=$(cat .nvmrc)
  pnpm_version=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)
  [ -n "$pnpm_version" ] || die 'No pinned pnpm version in package.json'
  # Docker's stdin is the context, with its default Dockerfile as the sole recipe source.
  # Stage only these two inputs, never the checkout or an ignored .env.
  mkdir -p node_modules/.cache/probes
  context=$(mktemp -d node_modules/.cache/probes/linux-build.XXXXXX)
  trap 'rm -rf -- "$context"' EXIT
  cp scripts/lib/linux-build.Dockerfile "$context/Dockerfile"
  cp scripts/lib/linux-node-path.sh "$context/linux-node-path.sh"
  COPYFILE_DISABLE=1 tar -C "$context" --create --file - Dockerfile linux-node-path.sh |
    step 'Build Linux image' docker build --platform "$linux_platform" --tag "$linux_image" \
      --build-arg "NODE_VERSION=$node_version" --build-arg "PNPM_VERSION=$pnpm_version" -
)

linux_archive() {
  # Include new files and local edits, omit ignored files, skip deletions, preserve symlinks.
  git ls-files -z --cached --others --exclude-standard |
    while IFS= read -r -d '' file; do
      if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\0' "$file"; fi
    done |
    COPYFILE_DISABLE=1 tar --null --files-from - --create --file -
}

linux_workspace() {
  local mode=$1
  local mounts=(--volume "$linux_image-pnpm:/home/node/.local/share/pnpm"
    --volume "$linux_image-electron:/home/node/.cache/electron"
    --volume "$linux_image-node:/home/node/corrallm/node_modules/.cache/corrallm-node")
  if [ "$mode" = ci ]; then
    mounts+=(--volume "$linux_image-results:/home/node/corrallm/test-results"
      --volume "$linux_image-report:/home/node/corrallm/playwright-report")
  fi
  if [ "$#" -eq 2 ]; then mounts+=(--volume "$2:/artifacts"); fi
  linux_archive | docker run --rm --interactive "${linux_docker[@]}" \
    --env HUSKY=0 --env CI=1 --env CORRALLM_UNSIGNED=1 --env CORRALLM_NO_UPDATE_CHECK=1 \
    --env PLAYWRIGHT_HTML_OPEN=never \
    "${mounts[@]}" "$linux_image" bash -c '
      set -Eeuo pipefail
      trap '\''printf "FAILED: unpack Linux working tree (exit %s)\n" "$?" >&2'\'' ERR
      tar --extract --file - --warning=no-unknown-keyword
      exec bash scripts/lib/linux-workspace.sh "$@"
    ' _ "$mode" "$linux_arch"
}
