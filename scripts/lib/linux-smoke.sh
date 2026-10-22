#!/usr/bin/env bash
# Same assertions for an out/ package and a clean distro's installed package. Run as non-root.
source "$(dirname "$0")/linux-steps.sh"
app=${1:?app executable required}
command=${2:?shipped command required}
[ "$(id -u)" -ne 0 ] || die 'Run app checks as a non-root user; keep the Chromium sandbox on'
[ -x "$app" ] && [ -x "$command" ] || die 'Missing app or shipped command'
run_app() { xvfb-run -a -s '-screen 0 1280x1024x24' "$app" "$@"; }

step 'Native self-test of packaged app (main, core and shipped Node)' \
  env CORRALLM_NATIVE_SELFTEST=1 xvfb-run -a -s '-screen 0 1280x1024x24' "$app"
for switch in --remote-debugging-port=0 --gpu-launcher=refused --renderer-cmd-prefix=refused; do
  LINUX_STEP="Refuse launch switch $switch"
  code=0
  CORRALLM_NATIVE_SELFTEST=1 run_app "$switch" || code=$?
  [ "$code" -eq 1 ] || die "App exited $code, expected refusal (1) for $switch"
  printf 'refused %s\n' "$switch"
done
step 'Shipped command self-test (empty PATH)' env PATH= CORRALLM_NATIVE_SELFTEST=1 "$command"
step 'Shipped command help (empty PATH)' env PATH= "$command" --help
