#!/usr/bin/env bash
# Make a release draft: bash scripts/release.sh [--dry-run] [--notes-file FILE] <version> <commit>
#
# Builds <commit> in a fresh clone, checks the exact artifacts it would attach, writes SHA256SUMS
# and creates a GitHub release DRAFT. It never publishes, never pushes a tag or a branch, and
# never builds from this checkout. Only a person publishes the draft; GitHub makes the tag then.
# Credentials are read from the environment (.env.example) and are never written or echoed.
#
# --dry-run: allows a commit off origin/main and an ad hoc-signed macOS build; skips notarization,
#   the --release checks and the draft; makes no `gh` call; writes only under
#   node_modules/.cache/probes/release-dry-run-*, and prints what it would have drafted.
# --notes-file FILE: the release notes (the first release's are written by hand); otherwise GitHub
#   generates them.
set -Eeuo pipefail
STEP=initialization
trap 'code=$?; printf "FAILED: %s (exit %s, %s:%s)\n" "$STEP" "$code" "${BASH_SOURCE[0]}" "$LINENO" >&2; exit "$code"' ERR

step() {
  STEP=$1
  shift
  printf '\n--- %s\n' "$STEP"
  "$@"
}

usage() {
  printf 'Usage: %s [--dry-run] [--notes-file FILE] <version> <commit>\n' "$0" >&2
  exit 2
}

dry_run=0
notes=
positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --notes-file)
      if [ "$#" -lt 2 ]; then usage; fi
      notes=$2
      shift
      ;;
    --upload* | --publish* | --draft=* | --no-draft | --release)
      printf 'Refusing %s: this script only makes a draft, and only a person publishes it.\n' "$1" >&2
      exit 2
      ;;
    -*) usage ;;
    *) positional+=("$1") ;;
  esac
  shift
done
if [ "${#positional[@]}" -ne 2 ]; then usage; fi
version=${positional[0]}
cd "$(dirname "$0")/.."
repo=$PWD
repository=jrbarkin/corrallm
SIGNING_VARIABLES=(APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
  APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)

# Temporary files. A dry run keeps everything under the probes folder; a real run uses the system
# temporary folder. Either way the clone and the temporary files are removed on success or failure.
if [ "$dry_run" -eq 1 ]; then
  mkdir -p node_modules/.cache/probes
  work=$(mktemp -d "$repo/node_modules/.cache/probes/release-dry-run-XXXXXX")
else
  work=$(mktemp -d "${TMPDIR:-/tmp}/corrallm-release.XXXXXX")
fi
clone=$work/clone
assets=$work/assets
scratch=$work/scratch
mkdir -p "$assets" "$scratch"
cleanup() {
  local code=$?
  rm -rf -- "$clone" "$scratch"
  if [ "$dry_run" -eq 0 ]; then rm -rf -- "$work"; fi
  exit "$code"
}
trap cleanup EXIT

# Everything that builds or runs the project's scripts does so in the clone, never in this checkout.
in_clone() { (cd "$clone" && "$@"); }

decide() { node "$repo/scripts/release-decide.mjs" "$@"; }

gather_facts() {
  # $1 = the audit's advisory count, or empty before the clone exists.
  local on_main=false tag_exists=false docker_runs=false
  if git merge-base --is-ancestor "$commit" origin/main; then on_main=true; fi
  if [ "$dry_run" -eq 0 ]; then
    if gh release view "v$version" >/dev/null 2>&1 ||
      git ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1; then
      tag_exists=true
    fi
    gh api "repos/$repository/commits/$commit/check-runs?per_page=100" --paginate \
      --jq '.check_runs[] | {name, status, conclusion}' >"$scratch/checks.jsonl"
  else
    : >"$scratch/checks.jsonl"
  fi
  if docker info >/dev/null 2>&1; then docker_runs=true; fi
  node -e '
    const [version, commit, packageVersion, onMain, tagExists, dockerRuns, dryRun, audit] =
      process.argv.slice(1);
    const facts = { version, commit, packageVersion, onMain: onMain === "true",
      tagExists: tagExists === "true", dockerRuns: dockerRuns === "true", dryRun: dryRun === "1" };
    if (audit !== "") facts.auditAdvisories = Number(audit);
    console.log(JSON.stringify(facts));
  ' -- "$version" "$commit" "$package_version" "$on_main" "$tag_exists" "$docker_runs" \
    "$dry_run" "${1:-}" >"$scratch/facts.json"
}

run_preflight() {
  if ! decide preflight "$scratch/facts.json" "$scratch/checks.jsonl"; then
    printf '\nRefused: the release did not pass its preflight. Nothing was built.\n' >&2
    return 1
  fi
}

resolve_commit() {
  git fetch --quiet origin
  commit=$(git rev-parse --verify --quiet "${positional[1]}^{commit}") ||
    { printf 'No such commit: %s\n' "${positional[1]}" >&2; return 1; }
  package_version=$(git show "$commit:package.json" |
    node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
}

# The audit runs in the clone, against the lockfile the release is built from.
audit_clone() {
  local advisories
  in_clone pnpm audit --json >"$scratch/audit.json" 2>/dev/null || true
  advisories=$(decide audit "$scratch/audit.json")
  if ! [ "$advisories" -eq "$advisories" ] 2>/dev/null; then
    printf 'pnpm audit gave no readable answer.\n' >&2
    return 1
  fi
  gather_facts "$advisories"
  run_preflight
}

make_clone() {
  git clone --quiet --no-checkout "$(git remote get-url origin)" "$clone"
  git -C "$clone" checkout --quiet --detach "$commit"
  in_clone pnpm install --frozen-lockfile
}

# The macOS build: a dry run signs nothing, so no credential is even passed to it.
build_macos() {
  if [ "$dry_run" -eq 1 ]; then
    local unset_args=()
    local name
    for name in "${SIGNING_VARIABLES[@]}"; do unset_args+=(-u "$name"); done
    in_clone env "${unset_args[@]}" pnpm make --platform darwin --arch arm64
  else
    in_clone pnpm make --platform darwin --arch arm64
  fi
  zip=$clone/out/make/zip/darwin/arm64/corrallm-darwin-arm64-$version.zip
  dmg=$clone/out/make/dmg/arm64/corrallm-$version-arm64.dmg
  if [ ! -f "$zip" ] || [ ! -f "$dmg" ]; then
    printf 'The make produced no %s or %s\n' "${zip##*/}" "${dmg##*/}" >&2
    return 1
  fi
}

# The dmg: signed, notarized and stapled with whichever credential form is set. The zip holds the
# stapled app (the packager notarized and stapled it).
notarize_dmg() {
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ]; then
    local issuer=()
    if [ -n "${APPLE_API_ISSUER:-}" ]; then issuer=(--issuer "$APPLE_API_ISSUER"); fi
    xcrun notarytool submit "$dmg" --wait --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
      ${issuer[@]+"${issuer[@]}"}
  else
    xcrun notarytool submit "$dmg" --wait --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
  fi
  xcrun stapler staple "$dmg"
}

build_linux() {
  local arch
  for arch in arm64 x64; do
    step "Build and check the Linux $arch packages" \
      in_clone bash scripts/check-linux-packages.sh "$arch" --out "$assets"
  done
}

# One file name per line for each asset: what is inside it, for the credential and notice scans.
list_dmg() {
  local mount=$scratch/dmg-mount
  mkdir -p "$mount"
  hdiutil attach -readonly -nobrowse -noverify -mountpoint "$mount" "$1" >/dev/null
  (cd "$mount" && find . -print) || { hdiutil detach "$mount" >/dev/null; return 1; }
  hdiutil detach "$mount" >/dev/null
}
list_asset() {
  case "$1" in
    *.zip) unzip -Z1 "$1" ;;
    *.dmg) list_dmg "$1" ;;
    *.deb) tar -xOf "$1" --include 'data.tar*' | tar -tf - ;;
    *.rpm) tar -tf "$1" ;;
  esac
}

scan_assets() {
  local file name
  for file in "$assets"/*.zip "$assets"/*.dmg "$assets"/*.deb "$assets"/*.rpm; do
    name=${file##*/}
    list_asset "$file" >"$scratch/listing.txt"
    decide scan "$name" "$scratch/listing.txt"
  done
  # The code itself: app.asar holds the app's JavaScript, which no listing above reaches.
  in_clone pnpm exec asar list \
    "$clone/out/corrallm-darwin-arm64/corrallm.app/Contents/Resources/app.asar" \
    >"$scratch/asar.txt"
  local credentials
  credentials=$(grep -E '(^|/)(\.env(\.[^/]*)?|[^/]+\.(p8|p12|pfx|pem|key))$' "$scratch/asar.txt" |
    grep -Ev '\.env\.(example|sample)$' || true)
  if [ -n "$credentials" ]; then
    printf 'app.asar holds a credential-like file:\n%s\n' "$credentials" >&2
    return 1
  fi
}

write_sums() {
  decide sums "$assets"
  (cd "$assets" && shasum -a 256 -c SHA256SUMS)
}

draft() {
  local flags=(--draft --target "$commit" --title "corrallm $version")
  case "$version" in *-beta.*) flags+=(--prerelease) ;; esac
  if [ -n "$notes" ]; then flags+=(--notes-file "$notes"); else flags+=(--generate-notes); fi
  gh release create "v$version" "${flags[@]}" "$assets"/*
}

show_dry_run() {
  printf '\nDry run: nothing was uploaded and no `gh` command ran.\n'
  printf 'Would draft v%s at %s (%s) with:\n' "$version" "$commit" \
    "$(case "$version" in *-beta.*) printf prerelease ;; *) printf release ;; esac)"
  (cd "$assets" && ls -l)
  printf 'The assets are kept in %s\n' "$assets"
}

step 'Resolve the commit' resolve_commit
gather_facts
step 'Preflight (what can be known before building)' run_preflight
step 'Clone the commit and install' make_clone
step 'Audit the lockfile' audit_clone
step 'Build the macOS app, dmg and zip' build_macos
if [ "$dry_run" -eq 0 ]; then step 'Sign, notarize and staple the dmg' notarize_dmg; fi
cp "$zip" "$dmg" "$assets/"
build_linux
if [ "$dry_run" -eq 0 ]; then
  step 'Check the macOS artifacts (release mode)' \
    in_clone bash scripts/check-macos.sh --release --zip "$assets/${zip##*/}" \
    --dmg "$assets/${dmg##*/}" arm64
fi
step 'Scan the artifacts for credentials and missing notices' scan_assets
step 'Write SHA256SUMS' write_sums
step 'Check the asset set' decide assets "$version" "$assets"
if [ "$dry_run" -eq 1 ]; then
  show_dry_run
else
  step 'Create the draft release' draft
  printf '\nDraft created. It is visible only to collaborators; publish it yourself.\n'
fi
