/**
 * The version the rpm carries. electron-installer-redhat turns the `-` of a prerelease into `.`,
 * so `0.1.0-beta.1` would become `0.1.0.beta.1`, which rpm ranks after `0.1.0`: a beta would
 * replace the release it precedes. `~` ranks before everything, so `0.1.0~beta.1` sorts first
 * (the deb installer makes the same choice by itself). A release's version is unchanged.
 */
export function rpmVersion(version: string): string {
  return version.replace('-', '~');
}
