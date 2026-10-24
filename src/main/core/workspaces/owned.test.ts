import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXCLUDED,
  OwnedRootError,
  ensureOwnedRoot,
  excludeOwnedRoot,
  projectOwnedRoot,
  verifyOwnedRoot,
} from './owned';
import { scratch } from './test-git';

/*
 * The folder a repository's workspaces' checkouts go in (B9a Design §2, Location): made by the
 * core inside the picked checkout, its own (a marker binds it to the repository), verified before
 * anything is written in it, refusing symlinks anywhere along it and folders it didn't make; and
 * the line in Git's local info/exclude that keeps it out of the checkout's status.
 */

const PROFILE = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';

let root: string;
let remove: () => void;
let realRoot: string;

beforeEach(() => {
  ({ root, remove } = scratch());
  realRoot = path.join(root, 'app');
  mkdirSync(path.join(realRoot, '.git', 'info'), { recursive: true });
});
afterEach(() => {
  remove();
});

function repository(id = REPOSITORY) {
  return { id, realRoot, ownedRoot: projectOwnedRoot(realRoot, PROFILE) };
}

function code(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OwnedRootError) return error.code;
    throw error;
  }
  return 'none';
}

describe.skipIf(process.platform === 'win32')('the owned root', () => {
  it('is <checkout>/.corral/worktrees/<profile>, made private and marked as the repository’s', () => {
    const owned = repository();
    expect(owned.ownedRoot).toBe(path.join(realRoot, '.corral', 'worktrees', PROFILE));
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('missing');
    ensureOwnedRoot(owned);
    expect(statSync(owned.ownedRoot).mode & 0o777).toBe(0o700);
    expect(readdirSync(owned.ownedRoot)).toEqual(['.corrallm-owner']);
    expect(lstatSync(path.join(owned.ownedRoot, '.corrallm-owner')).mode & 0o777).toBe(0o600);
    // Made once; verified, and made again as it is, any number of times.
    verifyOwnedRoot(owned);
    ensureOwnedRoot(owned);
    expect(readdirSync(owned.ownedRoot)).toEqual(['.corrallm-owner']);
  });

  it('refuses a symlink anywhere along it, writing nothing where it leads', () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(realRoot, '.corral'));
    expect(
      code(() => {
        ensureOwnedRoot(repository());
      }),
    ).toBe('symlinked');
    expect(readdirSync(outside)).toEqual([]);
    // Deeper too: .corral is a folder, worktrees a link.
    const other = path.join(root, 'other');
    mkdirSync(other);
    realRoot = path.join(root, 'app2');
    mkdirSync(path.join(realRoot, '.corral'), { recursive: true });
    symlinkSync(outside, path.join(realRoot, '.corral', 'worktrees'));
    expect(
      code(() => {
        ensureOwnedRoot(repository());
      }),
    ).toBe('symlinked');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a checkout it isn’t given by its real path', () => {
    const link = path.join(root, 'link');
    symlinkSync(realRoot, link);
    realRoot = link;
    expect(
      code(() => {
        ensureOwnedRoot(repository());
      }),
    ).toBe('symlinked');
  });

  it('refuses a folder it didn’t make, or another repository’s', () => {
    const owned = repository();
    mkdirSync(owned.ownedRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(owned.ownedRoot, 'work.txt'), 'someone’s\n');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(readdirSync(owned.ownedRoot)).toEqual(['work.txt']);
    // An empty one is adopted: there's nothing in it to protect.
    const empty = { ...owned, realRoot: path.join(root, 'app3') };
    empty.ownedRoot = projectOwnedRoot(empty.realRoot, PROFILE);
    mkdirSync(empty.ownedRoot, { recursive: true, mode: 0o700 });
    ensureOwnedRoot(empty);
    verifyOwnedRoot(empty);
    // Marked as another repository's.
    expect(
      code(() => {
        verifyOwnedRoot({ ...empty, id: '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51' });
      }),
    ).toBe('unowned');
  });

  it('refuses one others may write in', () => {
    const owned = repository();
    ensureOwnedRoot(owned);
    chmodSync(owned.ownedRoot, 0o777);
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('unowned');
  });

  it('refuses a root outside the checkout', () => {
    expect(
      code(() => {
        ensureOwnedRoot({ ...repository(), ownedRoot: path.join(root, 'x') });
      }),
    ).toBe('outside');
  });
});

describe.skipIf(process.platform === 'win32')('excludeOwnedRoot', () => {
  it('adds the owned subtree to info/exclude once, keeping what it held', () => {
    const exclude = path.join(realRoot, '.git', 'info', 'exclude');
    writeFileSync(exclude, '# mine\n*.log');
    excludeOwnedRoot(path.join(realRoot, '.git'));
    expect(readFileSync(exclude, 'utf8')).toBe(`# mine\n*.log\n${EXCLUDED}\n`);
    excludeOwnedRoot(path.join(realRoot, '.git'));
    expect(readFileSync(exclude, 'utf8')).toBe(`# mine\n*.log\n${EXCLUDED}\n`);
    expect(EXCLUDED).toBe('/.corral/worktrees/');
  });

  it('makes info/exclude if there is none', () => {
    const common = path.join(root, 'bare-ish');
    mkdirSync(common);
    excludeOwnedRoot(common);
    expect(readFileSync(path.join(common, 'info', 'exclude'), 'utf8')).toBe(`${EXCLUDED}\n`);
  });

  it('never writes through a symlink', () => {
    const victim = path.join(root, 'victim');
    writeFileSync(victim, 'keep\n');
    const exclude = path.join(realRoot, '.git', 'info', 'exclude');
    symlinkSync(victim, exclude);
    expect(
      code(() => {
        excludeOwnedRoot(path.join(realRoot, '.git'));
      }),
    ).toBe('exclude');
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    const other = path.join(root, 'common');
    mkdirSync(other);
    const target = path.join(root, 'info-elsewhere');
    mkdirSync(target);
    symlinkSync(target, path.join(other, 'info'));
    expect(
      code(() => {
        excludeOwnedRoot(other);
      }),
    ).toBe('exclude');
    expect(readdirSync(target)).toEqual([]);
  });
});
