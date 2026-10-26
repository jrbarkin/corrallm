import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCLUDED,
  OwnedRootError,
  ensureOwnedRoot,
  excludeOwnedRoot,
  projectOwnedRoot,
  verifyOwnedRoot,
} from './owned';
import { scratch } from './test-git';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
const realFs = await vi.importActual<typeof Fs>('node:fs');

/*
 * The folder a repository's workspaces' checkouts go in (B9a Design §2, Location): made by the
 * core inside the picked checkout, its own (a marker in the repository's common Git directory binds
 * the folder to the repository record), verified before anything is written in it, refusing
 * symlinks anywhere along it and folders it didn't make; and the line in Git's local info/exclude
 * that keeps it out of the checkout's status.
 */

const PROFILE = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const OTHER_REPOSITORY = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';

let root: string;
let remove: () => void;
let realRoot: string;

beforeEach(() => {
  ({ root, remove } = scratch());
  realRoot = checkout('app');
});
afterEach(() => {
  vi.mocked(lstatSync).mockImplementation(realFs.lstatSync);
  remove();
});

/** A checkout's folder with a Git directory of its own. */
function checkout(name: string): string {
  const at = path.join(root, name);
  mkdirSync(path.join(at, '.git', 'info'), { recursive: true });
  return at;
}

function repository(id = REPOSITORY, at = realRoot) {
  return {
    id,
    realRoot: at,
    commonDir: path.join(at, '.git'),
    ownedRoot: projectOwnedRoot(at, PROFILE),
  };
}

function markers(at = realRoot): string[] {
  try {
    return readdirSync(path.join(at, '.git', 'corrallm'));
  } catch {
    return [];
  }
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
  it('is <checkout>/.corral/worktrees/<profile>, made private, its marker kept in the Git directory', () => {
    const owned = repository();
    expect(owned.ownedRoot).toBe(path.join(realRoot, '.corral', 'worktrees', PROFILE));
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('missing');
    ensureOwnedRoot(owned);
    expect(statSync(owned.ownedRoot).mode & 0o777).toBe(0o700);
    // Nothing in the checkout a `git clean -fdx` there could take away.
    expect(readdirSync(owned.ownedRoot)).toEqual([]);
    const [marker] = markers();
    expect(marker).toMatch(/^owned-root-[0-9a-f]{32}\.json$/);
    const file = path.join(realRoot, '.git', 'corrallm', marker ?? '');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      corrallm: 'owned-root',
      repository: REPOSITORY,
      root: owned.ownedRoot,
    });
    // Made once; verified, and made again as it is, any number of times.
    verifyOwnedRoot(owned);
    writeFileSync(path.join(owned.ownedRoot, 'kept'), '');
    ensureOwnedRoot(owned);
    verifyOwnedRoot(owned);
    expect(markers()).toHaveLength(1);
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
    realRoot = checkout('app2');
    mkdirSync(path.join(realRoot, '.corral'));
    symlinkSync(outside, path.join(realRoot, '.corral', 'worktrees'));
    expect(
      code(() => {
        ensureOwnedRoot(repository());
      }),
    ).toBe('symlinked');
    expect(readdirSync(outside)).toEqual([]);
    // The marker's folder too.
    realRoot = checkout('app3');
    symlinkSync(outside, path.join(realRoot, '.git', 'corrallm'));
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
    expect(
      code(() => {
        ensureOwnedRoot(repository(REPOSITORY, link));
      }),
    ).toBe('symlinked');
  });

  it('refuses a folder it didn’t make, one put in its place, or another repository’s', () => {
    const owned = repository();
    mkdirSync(owned.ownedRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(owned.ownedRoot, 'work.txt'), 'someone’s\n');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(readdirSync(owned.ownedRoot)).toEqual(['work.txt']);
    expect(markers()).toEqual([]);
    // An empty one is adopted: there's nothing in it to protect.
    rmSync(path.join(owned.ownedRoot, 'work.txt'));
    ensureOwnedRoot(owned);
    verifyOwnedRoot(owned);
    // Another folder put in its place, with something in it, isn't the one marked.
    rmSync(owned.ownedRoot, { recursive: true });
    mkdirSync(owned.ownedRoot, { mode: 0o700 });
    writeFileSync(path.join(owned.ownedRoot, 'work.txt'), 'someone’s\n');
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
    rmSync(path.join(owned.ownedRoot, 'work.txt'));
    ensureOwnedRoot(owned);
    // Marked as another repository's.
    expect(
      code(() => {
        verifyOwnedRoot(repository(OTHER_REPOSITORY));
      }),
    ).toBe('unowned');
  });

  it('refuses a replacement even when the filesystem reuses the owned root’s inode', () => {
    const owned = repository();
    ensureOwnedRoot(owned);
    const previous = realFs.lstatSync(owned.ownedRoot, { bigint: true });
    rmSync(owned.ownedRoot, { recursive: true });
    mkdirSync(owned.ownedRoot, { mode: 0o700 });
    writeFileSync(path.join(owned.ownedRoot, 'work.txt'), 'someone’s\n');
    // Linux may do this naturally. Pin that identity reuse on every filesystem, independently
    // of its allocator or timestamp granularity: a new creation with the same device/inode.
    vi.mocked(lstatSync).mockImplementation((...args) => {
      const found = realFs.lstatSync(...args);
      return args[0] === owned.ownedRoot && typeof found?.ino === 'bigint'
        ? Object.assign(found, {
            dev: previous.dev,
            ino: previous.ino,
            birthtimeNs: previous.birthtimeNs + 1n,
          })
        : found;
    });
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(readdirSync(owned.ownedRoot)).toEqual(['work.txt']);
  });

  it('refuses ownership without a creation time, rather than trusting a reusable inode alone', () => {
    const owned = repository();
    ensureOwnedRoot(owned);
    vi.mocked(lstatSync).mockImplementation((...args) => {
      const found = realFs.lstatSync(...args);
      return args[0] === owned.ownedRoot && typeof found?.ino === 'bigint'
        ? Object.assign(found, { birthtimeNs: 0n })
        : found;
    });
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
  });

  it('refuses a nonempty root whose older marker proves only its inode', () => {
    const owned = repository();
    ensureOwnedRoot(owned);
    const marker = path.join(realRoot, '.git', 'corrallm', markers()[0] ?? '');
    writeFileSync(
      marker,
      `${JSON.stringify({
        corrallm: 'owned-root',
        repository: REPOSITORY,
        root: owned.ownedRoot,
        inode: realFs.lstatSync(owned.ownedRoot, { bigint: true }).ino.toString(),
      })}\n`,
    );
    writeFileSync(path.join(owned.ownedRoot, 'work.txt'), 'kept\n');
    expect(
      code(() => {
        verifyOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(
      code(() => {
        ensureOwnedRoot(owned);
      }),
    ).toBe('unowned');
    expect(readFileSync(path.join(owned.ownedRoot, 'work.txt'), 'utf8')).toBe('kept\n');
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
