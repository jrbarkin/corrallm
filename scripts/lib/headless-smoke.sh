#!/usr/bin/env bash
# The packaged command, proven headless (B30 C7): bash headless-smoke.sh <command> <node> <seed>
#   <command>  the shipped launcher (bin/corrallm), the command a user runs
#   <node>     the shipped Node, which runs the seeding bundle by absolute path
#   <seed>     dist-check/seed-profile.cjs, the test-only bundle that keeps one canvas in a
#              throwaway profile (it is never packed into the app or a package)
# Every call of the command runs with PATH empty: it needs no Node, tool or shell setup of its own.
# In a throwaway HOME and profile it serves a canvas, makes a token into a 0600 file on a pseudo-
# terminal, waits (exits 1, its time limit), revokes the token (wait then exits 2) and stops serve
# with SIGTERM, which exits 0 and leaves no api.json, core.lock or token.sock.
set -Eeuo pipefail
STEP=initialization
trap 'code=$?; printf "FAILED: %s (exit %s, %s:%s)\n" "$STEP" "$code" "${BASH_SOURCE[0]}" "$LINENO" >&2; exit "$code"' ERR

command=${1:?shipped command required}
node=${2:?shipped node required}
seed=${3:?seeding bundle required}
[ -x "$command" ] || { printf 'FAILED: no shipped command at %s\n' "$command" >&2; exit 1; }
[ -x "$node" ] || { printf 'FAILED: no shipped node at %s\n' "$node" >&2; exit 1; }
[ -f "$seed" ] || { printf 'FAILED: no seeding bundle at %s\n' "$seed" >&2; exit 1; }
# `script` is found with the caller's PATH; what it runs gets none.
script_tool=$(command -v script) || { printf 'FAILED: script(1) is needed for a pseudo-terminal\n' >&2; exit 1; }

say() { STEP=$1; printf '\n--- %s\n' "$STEP"; }
fail() { printf 'FAILED: %s: %s\n' "$STEP" "$*" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/corrallm-headless.XXXXXX")
serve_pid=
cleanup() {
  if [ -n "$serve_pid" ] && kill -0 "$serve_pid" 2>/dev/null; then kill -TERM "$serve_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
profile=$tmp/profile
project=$tmp/project
canvas=$tmp/m1.corral
token=$tmp/orchestrator.token
mkdir -p "$home" "$project" "$profile"
chmod 700 "$home" "$profile"
canvas_id=0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01

run() { env -i PATH= HOME="$home" "$@"; }

# A command on a pseudo-terminal (the token commands run only on one), with its exit status.
on_terminal() {
  local line
  line=$(printf '%q ' env -i PATH= HOME="$home" "$command" "$@")
  case "$(uname -s)" in
    Darwin) "$script_tool" -q /dev/null env -i PATH= HOME="$home" "$command" "$@" ;;
    *) "$script_tool" -qec "$line" /dev/null ;;
  esac
}

say 'The seeding bundle is not part of what ships'
real=$(readlink -f "$command" 2>/dev/null || printf '%s' "$command")
shipped=$(cd -P "$(dirname "$real")/../.." && pwd)
[ -z "$(find "$shipped" -name 'seed-profile*' -print -quit 2>/dev/null)" ] || fail 'the seeding bundle is packed with the app'

say 'Seed a throwaway profile with one kept canvas'
printf '{"format":"corrallm","version":2,"id":"%s","nodes":[],"links":[]}\n' "$canvas_id" >"$canvas"
run "$node" "$seed" "$profile" "$canvas" "$project"

say 'serve starts and publishes api.json'
# env execs the command, so $! is serve itself and SIGTERM reaches it.
env -i PATH= HOME="$home" "$command" serve --profile "$profile" --canvas "$canvas" --port 0 >"$tmp/serve.log" 2>&1 &
serve_pid=$!
for _ in $(seq 1 600); do
  [ -f "$profile/api.json" ] && break
  kill -0 "$serve_pid" 2>/dev/null || { cat "$tmp/serve.log" >&2; fail 'serve exited before it served'; }
  sleep 0.1
done
[ -f "$profile/api.json" ] || { cat "$tmp/serve.log" >&2; fail 'api.json did not appear within 60 s'; }
url=$(run "$node" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).url)' "$profile/api.json")
case "$url" in http://127.0.0.1:*) ;; *) fail "serve is not on loopback: $url" ;; esac

say 'token new --into writes one token to a 0600 file, on a terminal'
code=0
on_terminal token new --profile "$profile" --canvas "$canvas" --into "$token" >"$tmp/token.log" 2>&1 || code=$?
[ "$code" -eq 0 ] || { cat "$tmp/token.log" >&2; fail "token new exited $code"; }
case "$(uname -s)" in Darwin) mode=$(stat -f %Lp "$token") ;; *) mode=$(stat -c %a "$token") ;; esac
[ "$mode" = 600 ] || fail "the token file is mode $mode, not 600"
[ "$(wc -l <"$token" | tr -d ' ')" = 1 ] || fail 'the token file does not hold exactly one line'
[ "$(tr -d '\n' <"$token" | wc -c | tr -d ' ')" = 43 ] || fail 'the token is not 43 characters'
if grep -qF "$(cat "$token")" "$tmp/token.log"; then fail 'the token was shown although it was written to a file'; fi

say 'wait with the token passes its time limit (exit 1) and prints one JSON line'
code=0
env -i PATH= HOME="$home" CORRALLM_URL="$url" CORRALLM_OUTSIDE_TOKEN_FILE="$token" "$command" wait --timeout 1 >"$tmp/wait.out" 2>"$tmp/wait.err" || code=$?
[ "$code" -eq 1 ] || { cat "$tmp/wait.err" >&2; fail "wait exited $code, expected 1"; }
[ "$(wc -l <"$tmp/wait.out" | tr -d ' ')" = 1 ] || fail 'wait did not print exactly one line'

say 'token revoke on a terminal, after which wait is refused (exit 2)'
code=0
on_terminal token revoke --profile "$profile" >"$tmp/revoke.log" 2>&1 || code=$?
[ "$code" -eq 0 ] || { cat "$tmp/revoke.log" >&2; fail "token revoke exited $code"; }
code=0
env -i PATH= HOME="$home" CORRALLM_URL="$url" CORRALLM_OUTSIDE_TOKEN_FILE="$token" "$command" wait --timeout 1 >"$tmp/wait.out" 2>"$tmp/wait.err" || code=$?
[ "$code" -eq 2 ] || { cat "$tmp/wait.err" >&2; fail "wait exited $code after the revoke, expected 2"; }

say 'SIGTERM stops serve cleanly, leaving no api.json, core.lock or token.sock'
kill -TERM "$serve_pid"
stopped=
for _ in $(seq 1 300); do
  kill -0 "$serve_pid" 2>/dev/null || { stopped=yes; break; }
  sleep 0.1
done
[ -n "$stopped" ] || fail 'serve did not stop within 30 s'
code=0
wait "$serve_pid" || code=$?
serve_pid=
[ "$code" -eq 0 ] || { cat "$tmp/serve.log" >&2; fail "serve exited $code, expected 0"; }
for left in api.json core.lock token.sock; do
  [ ! -e "$profile/$left" ] || fail "$left remains after serve stopped"
done
printf '\nPackaged headless check: passed.\n'
