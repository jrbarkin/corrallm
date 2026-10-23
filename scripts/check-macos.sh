#!/usr/bin/env bash
# Check a freshly packaged macOS app: pnpm package, then bash scripts/check-macos.sh [arm64|x64].
# No build or download here; verify the exact bundle that would be distributed.
set -Eeuo pipefail
CHECK_STEP=initialization
trap 'code=$?; printf "FAILED: %s (exit %s, %s:%s)\n" "$CHECK_STEP" "$code" "${BASH_SOURCE[0]}" "$LINENO" >&2; exit "$code"' ERR

step() {
  CHECK_STEP=$1
  shift
  printf '\n--- %s\n' "$CHECK_STEP"
  "$@"
}

if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [arm64|x64]\n' "$0" >&2
  exit 2
fi
arch=${1:-$(uname -m)}
case "$arch" in
  arm64|x64) ;;
  x86_64) arch=x64 ;;
  *) printf 'Usage: %s [arm64|x64]\n' "$0" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
app="$PWD/out/corrallm-darwin-$arch/corrallm.app"
binary="$app/Contents/MacOS/corrallm"
command="$app/Contents/Resources/bin/corrallm"

step 'Verify macOS bundle signature' codesign --verify --deep --strict "$app"
step 'Check node-pty spawn-helper is executable' \
  test -x "$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-$arch/spawn-helper"
step 'Packaged app native self-test (main, core and shipped Node)' \
  env CORRALLM_NATIVE_SELFTEST=1 "$binary"

for switch in --remote-debugging-port=0 --gpu-launcher=refused --renderer-cmd-prefix=refused; do
  CHECK_STEP="Refuse launch switch $switch"
  code=0
  CORRALLM_NATIVE_SELFTEST=1 "$binary" "$switch" || code=$?
  if [ "$code" -ne 1 ]; then
    printf 'FAILED: packaged app accepted %s (exit %s, expected 1)\n' "$switch" "$code" >&2
    exit 1
  fi
  printf 'refused %s\n' "$switch"
done

step 'Shipped command self-test (empty PATH)' env PATH= CORRALLM_NATIVE_SELFTEST=1 "$command"
step 'Shipped command help (empty PATH)' env -u CORRALLM_NATIVE_SELFTEST PATH= "$command" --help
printf '\nmacOS %s packaged checks: passed.\n' "$arch"
