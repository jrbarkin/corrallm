#!/usr/bin/env bash
# Check a freshly packaged macOS app: pnpm package, then bash scripts/check-macos.sh [arm64|x64].
# No build or download of the bundle here; verify the exact bundle that would be distributed.
# The headless check also needs the test-only seeding bundle (never packed), built below.
#
# --release adds what a signed release must hold, on the packaged app and on every zip's app and
# every disk image named:
#   bash scripts/check-macos.sh --release [--zip FILE]... [--dmg FILE]... [arm64|x64]
# It needs APPLE_SIGNING_IDENTITY: the team in its parentheses is the one that must have signed.
# Without --release this is the development check, which an ad hoc signature passes.
set -Eeuo pipefail
CHECK_STEP=initialization
trap 'code=$?; printf "FAILED: %s (exit %s, %s:%s)\n" "$CHECK_STEP" "$code" "${BASH_SOURCE[0]}" "$LINENO" >&2; exit "$code"' ERR

step() {
  CHECK_STEP=$1
  shift
  printf '\n--- %s\n' "$CHECK_STEP"
  "$@"
}

usage() {
  printf 'Usage: %s [--release [--zip FILE]... [--dmg FILE]...] [arm64|x64]\n' "$0" >&2
  exit 2
}
release=0
zips=()
dmgs=()
arch=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) release=1 ;;
    --zip | --dmg)
      if [ "$release" -ne 1 ] || [ "$#" -lt 2 ]; then usage; fi
      if [ "$1" = --zip ]; then zips+=("$2"); else dmgs+=("$2"); fi
      shift
      ;;
    arm64 | x64 | x86_64)
      if [ -n "$arch" ]; then usage; fi
      arch=$1
      ;;
    *) usage ;;
  esac
  shift
done
arch=${arch:-$(uname -m)}
case "$arch" in
  arm64 | x64) ;;
  x86_64) arch=x64 ;;
  *) usage ;;
esac
cd "$(dirname "$0")/.."
app="$PWD/out/corrallm-darwin-$arch/corrallm.app"
binary="$app/Contents/MacOS/corrallm"
command="$app/Contents/Resources/bin/corrallm"

configured_id=$(sed -n "s/^ *appBundleId: '\\([^']*\\)',\$/\\1/p" forge.config.mts)
if [ -z "$configured_id" ]; then
  printf 'FAILED: forge.config.mts names no appBundleId\n' >&2
  exit 1
fi
source scripts/lib/notices-check.sh
version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' package.json)

plist_value() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist"; }

check_identity() {
  local found
  found=$(plist_value "$1" CFBundleIdentifier)
  if [ "$found" != "$configured_id" ]; then
    printf 'bundle id %s, but forge.config.mts says %s\n' "$found" "$configured_id" >&2
    return 1
  fi
}

# One path's signing details, as codesign prints them (to stderr).
signature() { codesign --display --verbose=4 "$1" 2>&1; }

check_hardened() {
  local details
  details=$(signature "$1")
  case "$details" in
    *'flags='*'(runtime'* | *'flags='*',runtime'*) ;;
    *) printf 'no hardened runtime on %s\n' "$1" >&2; return 1 ;;
  esac
}

# The entitlements of a signed path must be exactly the committed plist's.
check_entitlements() {
  if ! codesign --display --entitlements :- "$1" 2>/dev/null |
    node scripts/lib/entitlements-equal.mjs "$2"; then
    printf 'entitlements of %s differ from %s\n' "$1" "$2" >&2
    return 1
  fi
}

check_release_app() {
  local bundle=$1 team details helper code
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    printf 'APPLE_SIGNING_IDENTITY is not set\n' >&2
    return 1
  fi
  team=$(printf '%s' "$APPLE_SIGNING_IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
  if [ -z "$team" ]; then
    printf 'APPLE_SIGNING_IDENTITY names no team in parentheses\n' >&2
    return 1
  fi
  codesign --verify --deep --strict "$bundle"
  details=$(signature "$bundle")
  case "$details" in
    *'Signature=adhoc'*) printf 'ad hoc signature on %s\n' "$bundle" >&2; return 1 ;;
  esac
  case "$details" in
    *'Authority=Developer ID Application:'*) ;;
    *) printf 'not signed by a Developer ID Application authority: %s\n' "$bundle" >&2; return 1 ;;
  esac
  case "$details" in
    *"TeamIdentifier=$team"*) ;;
    *) printf 'not signed by team %s: %s\n' "$team" "$bundle" >&2; return 1 ;;
  esac
  check_hardened "$bundle"
  for helper in "$bundle"/Contents/Frameworks/*.app; do
    if [ -e "$helper" ]; then check_hardened "$helper"; fi
  done
  check_hardened "$bundle/Contents/Resources/cli/node"
  check_entitlements "$bundle" build/entitlements.mac.plist
  check_entitlements "$bundle/Contents/Resources/cli/node" build/entitlements.node.plist
  xcrun stapler validate "$bundle"
  code=0
  details=$(spctl --assess --type execute --verbose=4 "$bundle" 2>&1) || code=$?
  if [ "$code" -ne 0 ]; then
    printf 'Gatekeeper rejects %s\n%s\n' "$bundle" "$details" >&2
    return 1
  fi
  case "$details" in
    *'Notarized Developer ID'*) ;;
    *) printf 'not a notarized Developer ID app: %s\n' "$bundle" >&2; return 1 ;;
  esac
  check_identity "$bundle"
  if [ "$(plist_value "$bundle" CFBundleShortVersionString)" != "$version" ]; then
    printf 'the version in Info.plist is not %s\n' "$version" >&2
    return 1
  fi
  node scripts/check-fuses.mjs "$bundle/Contents/MacOS/corrallm"
}

scratches=()
trap 'for scratch in ${scratches[@]+"${scratches[@]}"}; do rm -rf -- "$scratch"; done' EXIT

# The app inside a release zip is what an update installs. Not a `||` list: set -e stops applying
# inside one, and a failed check would pass.
check_release_zip() {
  local scratch
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/corrallm-zip-check.XXXXXX")
  scratches+=("$scratch")
  ditto -x -k "$1" "$scratch"
  check_release_app "$scratch/corrallm.app"
}

check_release_dmg() {
  local details
  xcrun stapler validate "$1"
  if ! details=$(spctl --assess --type open --context context:primary-signature --verbose=4 "$1" 2>&1); then
    printf 'Gatekeeper rejects %s\n%s\n' "$1" "$details" >&2
    return 1
  fi
  case "$details" in
    *'Notarized Developer ID'*) ;;
    *) printf 'not a notarized Developer ID image: %s\n' "$1" >&2; return 1 ;;
  esac
}

step 'Verify macOS bundle signature' codesign --verify --deep --strict "$app"
step 'Check bundle id against forge.config.mts' check_identity "$app"
step 'Check node-pty spawn-helper is executable' \
  test -x "$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-$arch/spawn-helper"
step 'Check the shipped notices' check_shipped_notices "$app/Contents/Resources"
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
step 'Build the headless check seeding bundle (test-only, never packed)' pnpm build:seed
step 'Shipped command headless round trip (empty PATH)' \
  bash scripts/lib/headless-smoke.sh "$command" "$app/Contents/Resources/cli/node" "$PWD/dist-check/seed-profile.cjs"

if [ "$release" -eq 1 ]; then
  step 'Release checks on the packaged app' check_release_app "$app"
  for zip in ${zips[@]+"${zips[@]}"}; do
    step "Release checks on the app in $zip" check_release_zip "$zip"
  done
  for dmg in ${dmgs[@]+"${dmgs[@]}"}; do
    step "Release checks on $dmg" check_release_dmg "$dmg"
  done
fi
printf '\nmacOS %s packaged checks: passed.\n' "$arch"
