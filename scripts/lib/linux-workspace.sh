#!/usr/bin/env bash
# Inside the non-root build container after receiving the working tree.
source "$(dirname "$0")/linux-steps.sh"
mode=${1:?mode required}
arch=${2:?architecture required}
artifacts=${3:-/artifacts}

collect_installers() {
  local debs=(out/make/deb/"$arch"/*.deb)
  local rpms=(out/make/rpm/"$arch"/*.rpm)
  [ "${#debs[@]}" -eq 1 ] && [ -f "${debs[0]}" ] || die 'Expected exactly one deb'
  [ "${#rpms[@]}" -eq 1 ] && [ -f "${rpms[0]}" ] || die 'Expected exactly one rpm'
  cp "${debs[0]}" "$artifacts/corrallm.deb"
  cp "${rpms[0]}" "$artifacts/corrallm.rpm"
  cp "$(dirname "$0")"/linux-{steps,smoke,installed}.sh "$artifacts/"
  chmod -R a+rX "$artifacts"
}

step 'Install dependencies' pnpm install --frozen-lockfile
step 'Download Electron' pnpm exec install-electron
case "$mode" in
  ci)
    step 'Typecheck' pnpm typecheck
    step 'Lint' pnpm lint
    step 'Check formatting' pnpm format:check
    step 'Unit tests' pnpm test
    # The ordinary global setup builds both production bundles; no E2E_SKIP_BUILD shortcut.
    step 'End-to-end tests (including production build)' \
      xvfb-run -a -s '-screen 0 1280x1024x24' pnpm test:e2e --trace retain-on-failure --reporter=list,html
    ;;
  smoke)
    step 'Package Linux app' pnpm package --platform linux --arch "$arch"
    step 'Packaged Linux checks' bash "$(dirname "$0")/linux-smoke.sh" \
      "out/corrallm-linux-$arch/corrallm" "out/corrallm-linux-$arch/resources/bin/corrallm"
    ;;
  packages)
    # Forge 8 names our Maker instances deb/rpm. Module names create NEW default instances,
    # losing the configured launcher, desktop template, dependencies and patched RPM spec.
    step 'Make deb and rpm' pnpm make --platform linux --arch "$arch" \
      --targets deb,rpm
    step 'Collect installers' collect_installers
    ;;
  *) die "Unknown workspace mode: $mode" ;;
esac
printf '\nLinux %s %s: passed.\n' "$arch" "$mode"
