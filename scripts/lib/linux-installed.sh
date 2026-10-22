#!/usr/bin/env bash
# Root installs/uninstalls; only the app/CLI checks run as the dedicated, unprivileged user.
source /checks/linux-steps.sh
distro=${1:?distribution required}
arch=${2:?architecture required}

linked_libraries() {
  local file listing
  for file in /usr/lib/corrallm/corrallm /usr/lib/corrallm/resources/cli/node; do
    listing=$(ldd "$file")
    printf '%s\n' "$listing"
    if [[ "$listing" == *'not found'* ]]; then die "Missing linked library for $file"; fi
  done
}

case "$distro" in
  debian:bookworm)
    step 'Refresh Debian package metadata' apt-get update
    step 'Install deb (declared dependencies only)' \
      apt-get install --yes --no-install-recommends /checks/corrallm.deb
    step 'Check deb identity and architecture' dpkg-query -W -f='${Package} ${Architecture}\n' corrallm
    deb_arch=$arch
    if [ "$arch" = x64 ]; then deb_arch=amd64; fi
    [ "$(dpkg-query -W -f='${Architecture}' corrallm)" = "$deb_arch" ] || die 'Wrong deb architecture'
    # Do this BEFORE display tools can accidentally supply an undeclared app library.
    step 'Check linked libraries before test tools' linked_libraries
    step 'Install headless test tools' apt-get install --yes --no-install-recommends \
      xvfb xauth desktop-file-utils util-linux passwd
    ;;
  fedora:44)
    step 'Install rpm (declared dependencies only)' \
      dnf --assumeyes --setopt=install_weak_deps=False install /checks/corrallm.rpm
    step 'Check rpm identity and architecture' rpm -q --qf '%{NAME} %{ARCH}\n' corrallm
    rpm_arch=aarch64
    if [ "$arch" = x64 ]; then rpm_arch=x86_64; fi
    [ "$(rpm -q --qf '%{ARCH}' corrallm)" = "$rpm_arch" ] || die 'Wrong rpm architecture'
    step 'Check linked libraries before test tools' linked_libraries
    step 'Install headless test tools' dnf --assumeyes --setopt=install_weak_deps=False install \
      xorg-x11-server-Xvfb xorg-x11-xauth desktop-file-utils util-linux shadow-utils
    ;;
  *) die "Unknown distribution: $distro" ;;
esac

step 'Check launcher symlink' test "$(readlink -f /usr/bin/corrallm)" = /usr/lib/corrallm/resources/bin/corrallm
step 'Validate desktop entry' desktop-file-validate /usr/share/applications/corrallm.desktop
step 'Check desktop opens GUI' grep -Fx 'Exec=/usr/lib/corrallm/corrallm %U' /usr/share/applications/corrallm.desktop
[ -x /usr/lib/corrallm/corrallm ] || die 'Desktop target is not executable'
if command -v node; then die 'Runtime image unexpectedly contains Node on PATH'; fi

step 'Create non-root test user' useradd --create-home tester
step 'Test installed app and command as non-root' runuser -u tester -- \
  env HOME=/home/tester CORRALLM_NO_UPDATE_CHECK=1 \
  bash /checks/linux-smoke.sh /usr/lib/corrallm/corrallm /usr/bin/corrallm

case "$distro" in
  debian:bookworm) step 'Uninstall deb' apt-get purge --yes corrallm ;;
  fedora:44) step 'Uninstall rpm' dnf --assumeyes remove corrallm ;;
esac
LINUX_STEP='Check uninstall removed command'
if [ -e /usr/bin/corrallm ] || [ -L /usr/bin/corrallm ]; then die '/usr/bin/corrallm remains after uninstall'; fi
printf '\n%s %s: installed package passed and uninstalled cleanly.\n' "$distro" "$arch"
