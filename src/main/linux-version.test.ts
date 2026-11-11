import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The installers' own conversions, which decide what the released packages are called. Neither
// package types its exports, and the redhat one exports its helper only by file.

const redhatUtil = (await import(
  pathToFileURL(
    path.join(
      path.dirname(createRequire(import.meta.url).resolve('electron-installer-redhat')),
      'util.js',
    ),
  ).href
)) as { replaceInvalidVersionCharacters: (version: string) => string };
const redhatVersion = redhatUtil.replaceInvalidVersionCharacters;
// @ts-expect-error - the package has no types
const debian = (await import('electron-installer-debian')) as {
  transformVersion: (version: string) => string;
};
const debVersion = debian.transformVersion;

import { rpmVersion } from '../../build/linux-version';
import { debVersion as releaseDebVersion } from '../../build/release';

/** The order of the characters in one non-digit run, as Debian and rpm both rank them. */
function rank(char: string | undefined, debian: boolean): number {
  if (char === undefined) return 0;
  if (char === '~') return -1;
  if (/[A-Za-z]/.test(char)) return char.charCodeAt(0);
  return debian ? char.charCodeAt(0) + 256 : 0;
}

/** dpkg's comparison (policy 5.6.12) of upstream versions without an epoch or a revision. */
function dpkgCompare(a: string, b: string): number {
  let x = a;
  let y = b;
  while (x !== '' || y !== '') {
    const textX = /^[^0-9]*/.exec(x)?.[0] ?? '';
    const textY = /^[^0-9]*/.exec(y)?.[0] ?? '';
    for (let index = 0; index < Math.max(textX.length, textY.length); index++) {
      const diff = rank(textX[index], true) - rank(textY[index], true);
      if (diff !== 0) return Math.sign(diff);
    }
    x = x.slice(textX.length);
    y = y.slice(textY.length);
    const numberX = /^[0-9]*/.exec(x)?.[0] ?? '';
    const numberY = /^[0-9]*/.exec(y)?.[0] ?? '';
    const diff = Number(numberX || 0) - Number(numberY || 0);
    if (diff !== 0) return Math.sign(diff);
    x = x.slice(numberX.length);
    y = y.slice(numberY.length);
  }
  return 0;
}

/** rpm's rpmvercmp: segments of digits or letters, `~` sorting before everything, even the end. */
function rpmCompare(a: string, b: string): number {
  const split = (version: string) => version.match(/~|[0-9]+|[A-Za-z]+/g) ?? [];
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    if (x === '~') return -1;
    if (y === '~') return 1;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^[0-9]/;
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? 1 : -1;
    if (numeric.test(x)) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

describe('a prerelease sorts before its release', () => {
  it.each(['0.1.0-beta.1', '0.1.0-beta.2', '1.2.3-rc.1'])(
    'in the deb the installer makes of %s',
    (version) => {
      const release = version.replace(/-.*$/, '');
      expect(dpkgCompare(debVersion(version), release)).toBe(-1);
    },
  );

  it.each(['0.1.0-beta.1', '0.1.0-beta.2', '1.2.3-rc.1'])(
    'in the rpm the installer makes of %s',
    (version) => {
      const release = version.replace(/-.*$/, '');
      expect(rpmCompare(redhatVersion(rpmVersion(version)), release)).toBe(-1);
    },
  );

  it('and betas keep their order', () => {
    expect(
      rpmCompare(
        redhatVersion(rpmVersion('0.1.0-beta.1')),
        redhatVersion(rpmVersion('0.1.0-beta.2')),
      ),
    ).toBe(-1);
    expect(dpkgCompare(debVersion('0.1.0-beta.1'), debVersion('0.1.0-beta.2'))).toBe(-1);
  });

  it('while a release keeps its own version, and a later release sorts after', () => {
    expect(rpmVersion('0.1.0')).toBe('0.1.0');
    expect(rpmCompare(rpmVersion('0.1.1'), rpmVersion('0.1.0-beta.9'))).toBe(1);
  });
});

describe('the release’s asset names', () => {
  it.each(['0.1.0', '0.1.0-beta.1', '1.2.3-beta.12'])(
    'convert %s as the deb installer does',
    (version) => {
      expect(releaseDebVersion(version)).toBe(debVersion(version));
    },
  );
});

describe('the comparison itself', () => {
  it('knows the installers’ unfixed conversion sorts a prerelease after its release', () => {
    // electron-installer-redhat turns the `-` of 0.1.0-beta.1 into `.`, which rpm ranks higher.
    expect(rpmCompare(redhatVersion('0.1.0-beta.1'), '0.1.0')).toBe(1);
  });
});
