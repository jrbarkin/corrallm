#!/usr/bin/env bash
# Version checks for an installed package, sourced by linux-installed.sh (needs linux-steps.sh's
# `die`). A prerelease's package must sort before its release's, or an update would skip the release.

# $1 = distribution, $2 = the deb version, $3 = the rpm version this release must carry (the
# installers' own conversions of package.json's version, from build/release.ts).
check_installed_version() {
  local installed expected
  case "$1" in
    fedora:44)
      installed=$(rpm -q --qf '%{VERSION}' corrallm)
      expected=$3
      ;;
    *)
      installed=$(dpkg-query -W -f='${Version}' corrallm)
      expected=$2
      ;;
  esac
  [ "$installed" = "$expected" ] || die "Installed version $installed, expected $expected"
}

# The real tools' order for a fixed beta, whatever is installed: the conversion must sort below
# its release (electron-installer-redhat's own `0.1.0.beta.1` sorts above it).
check_prerelease_tools() {
  case "$1" in
    fedora:44)
      [[ "$(rpm --eval "%{lua: print(rpm.vercmp('0.1.0~beta.1', '0.1.0'))}")" == -1 ]] ||
        die 'rpm does not sort 0.1.0~beta.1 before 0.1.0'
      ;;
    *)
      dpkg --compare-versions 0.1.0~beta.1 lt 0.1.0 ||
        die 'dpkg does not sort 0.1.0~beta.1 before 0.1.0'
      ;;
  esac
}
