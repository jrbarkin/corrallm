#!/usr/bin/env bash
# Inside a container: keep the installers that were installed and checked, under their release
# names, in an output folder. Usage: linux-keep.sh <checks folder> <output folder>
# <checks>/corrallm.deb and corrallm.rpm are what the installed checks used; <checks>/release/
# holds the same bytes under the names Forge gave them. A mismatch is refused, so the kept
# files are the checked ones.
source "$(dirname "$0")/linux-steps.sh"
checks=${1:?checks folder required}
out=${2:?output folder required}

for kind in deb rpm; do
  kept=("$checks"/release/*."$kind")
  [ "${#kept[@]}" -eq 1 ] && [ -f "${kept[0]}" ] || die "Expected exactly one $kind in release/"
  cmp --quiet "$checks/corrallm.$kind" "${kept[0]}" ||
    die "${kept[0]} differs from the installed $kind"
  cp "${kept[0]}" "$out/"
  cmp --quiet "${kept[0]}" "$out/$(basename "${kept[0]}")" || die "Copy of ${kept[0]} differs"
  (cd "$out" && sha256sum -- "$(basename "${kept[0]}")")
done
