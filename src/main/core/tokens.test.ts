import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { TokenStore } from './tokens';

/*
 * Outside tokens (decisions 8 and 20b; API Spec §8.5): made by a person, named, reaching the
 * canvases picked when made, read-only or read-write, expiring within 12 hours, kept only as a
 * hash, and replaced by a new token of the same name, whose party carries over.
 */

/** What the file system was asked to force to disk, and to move, in order (by base name). */
const disk = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        disk.push(`fsync ${path.basename(String(args[0]))}`);
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      disk.push(`rename to ${path.basename(String(args[1]))}`);
    },
  };
});

const M1 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01' as CanvasId;
const WORKER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02' as CanvasId;
const HOUR = 60 * 60 * 1000;
/** Whether a file's permissions can keep its owner from reading it: not on Windows, nor as root. */
const CAN_DENY = process.platform !== 'win32' && process.getuid?.() !== 0;

let dir: string;
let file: string;
let now: number;
const clock = () => now;
/** Every store a test made: what each is writing is done before its folder goes. */
let stores: TokenStore[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-tokens-'));
  file = path.join(dir, 'tokens.json');
  now = Date.UTC(2026, 9, 18, 12);
  stores = [];
});

afterEach(async () => {
  for (const tokens of stores) await tokens.flush().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function store(): Promise<TokenStore> {
  const tokens = new TokenStore(file, clock);
  stores.push(tokens);
  await tokens.load();
  return tokens;
}

describe('TokenStore', () => {
  it('makes a token of 256 random bits, keeping only its hash, in a file only you can read', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(await tokens.create({ name: 'other', canvases: [M1], access: 'write' })).not.toBe(token);

    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(token);
    const kept = JSON.parse(text) as { version: number; tokens: Record<string, unknown> };
    expect(kept.version).toBe(2);
    expect(kept.tokens[sha256(token)]).toMatchObject({
      name: 'orchestrator',
      canvases: [M1],
      access: 'write',
      expires: now + HOUR,
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['tokens.json']);
  });

  it('names its caller: an outside orchestrator by the token’s name, with its access and canvases', async () => {
    const tokens = await store();
    const token = await tokens.create({
      name: 'orchestrator',
      canvases: [M1, WORKER],
      access: 'read',
      hours: 12,
    });
    expect(tokens.clientOf(token)).toMatchObject({
      kind: 'outside',
      name: 'orchestrator',
      access: 'read',
      canvases: [M1, WORKER],
    });
    // Its id is never the token itself.
    expect(tokens.clientOf(token)?.token).not.toBe(token);
    expect(tokens.clientOf('not-a-token')).toBeUndefined();
    expect(tokens.clientOf('')).toBeUndefined();
  });

  it('makes a token that writes but can’t merge (--no-merge): kept as its own access, an outside writer that may not merge', async () => {
    const tokens = await store();
    const token = await tokens.create({
      name: 'builder',
      canvases: [M1],
      access: 'write-no-merge',
    });
    const write = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const read = await tokens.create({ name: 'watcher', canvases: [M1], access: 'read' });
    // Its party is a writer's (outside-write); only merging is withheld.
    expect(tokens.clientOf(token)).toMatchObject({ access: 'write', merge: false });
    expect(tokens.clientOf(write)).toMatchObject({ access: 'write', merge: true });
    expect(tokens.clientOf(read)).toMatchObject({ access: 'read', merge: false });
    expect(tokens.grant('builder')?.access).toBe('write-no-merge');
    // The restriction is the access itself, never a field beside 'write' an older corrallm would
    // keep without reading, and so widen.
    await tokens.flush();
    const kept = JSON.parse(await readFile(file, 'utf8')) as {
      tokens: Record<string, Record<string, unknown>>;
    };
    expect(kept.tokens[sha256(token)]).toEqual({
      id: expect.any(String) as unknown,
      name: 'builder',
      canvases: [M1],
      access: 'write-no-merge',
      expires: now + HOUR,
      lastUsed: now,
    });
    // Across a restart, as it was made.
    expect((await store()).clientOf(token)).toMatchObject({
      name: 'builder',
      access: 'write',
      merge: false,
    });
  });

  it('reads an access it doesn’t know as no token, never a writer, and drops it: as an older corrallm reads write-no-merge', async () => {
    // A corrallm from before --no-merge knows only read and write: write-no-merge is to it what
    // an access from after this one (here write-no-push) is to this one.
    const entry = (access: string) => ({
      id: 'a',
      name: 'builder',
      canvases: [M1],
      access,
      expires: now + HOUR,
    });
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        tokens: { [sha256('x')]: entry('write-no-push'), [sha256('y')]: entry('write') },
      }),
    );
    const tokens = await store();
    expect(tokens.clientOf('x')).toBeUndefined();
    expect(tokens.grant('builder')?.access).toBe('write');
    expect(tokens.stale('x')).toBe(false);
    // Dropped as the store is written again: a person makes a new one.
    await tokens.create({ name: 'other', canvases: [M1], access: 'read' });
    const written = JSON.parse(await readFile(file, 'utf8')) as {
      tokens: Record<string, unknown>;
    };
    expect(written.tokens[sha256('x')]).toBeUndefined();
    expect(written.tokens[sha256('y')]).toMatchObject({ access: 'write' });
  });

  it('keeps tokens across restarts, until they expire: an hour by default, at most 12', async () => {
    const first = await store();
    const hour = await first.create({ name: 'quick', canvases: [M1], access: 'write' });
    const day = await first.create({ name: 'long', canvases: [M1], access: 'write', hours: 12 });

    const again = await store();
    expect(again.clientOf(hour)?.name).toBe('quick');
    now += HOUR - 1;
    expect(again.clientOf(hour)?.name).toBe('quick');
    now += 1;
    expect(again.clientOf(hour)).toBeUndefined();
    expect(again.clientOf(day)?.name).toBe('long');
    now += 11 * HOUR;
    expect(again.clientOf(day)).toBeUndefined();

    await expect(
      first.create({ name: 'x', canvases: [M1], access: 'write', hours: 13 }),
    ).rejects.toThrow(/1 to 12 hours/);
    await expect(
      first.create({ name: 'x', canvases: [M1], access: 'write', hours: 0 }),
    ).rejects.toThrow(/1 to 12 hours/);
    await expect(
      first.create({ name: 'x', canvases: [M1], access: 'write', hours: 1.5 }),
    ).rejects.toThrow(/1 to 12 hours/);
  });

  it('replaces a token by a new one of its name at once, the party carrying over', async () => {
    const tokens = await store();
    const old = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const oldId = tokens.clientOf(old)?.token ?? '';
    const other = await tokens.create({ name: 'other', canvases: [M1], access: 'write' });

    const renewed = await tokens.create({
      name: 'orchestrator',
      canvases: [WORKER],
      access: 'read',
    });
    expect(tokens.clientOf(old)).toBeUndefined();
    expect(tokens.revoked(oldId)).toBe(true);
    expect(tokens.clientOf(renewed)).toMatchObject({
      name: 'orchestrator',
      access: 'read',
      canvases: [WORKER],
    });
    expect(tokens.revoked(tokens.clientOf(renewed)?.token ?? '')).toBe(false);
    expect(tokens.clientOf(other)?.name).toBe('other');

    // And stays replaced across a restart.
    const again = await store();
    expect(again.clientOf(old)).toBeUndefined();
    expect(again.clientOf(renewed)?.name).toBe('orchestrator');
    const kept = JSON.parse(await readFile(file, 'utf8')) as { tokens: Record<string, unknown> };
    expect(Object.keys(kept.tokens)).toHaveLength(2);
  });

  it('forces a token’s replacement to disk before it returns the new one', async () => {
    const tokens = await store();
    await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    disk.length = 0;
    await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    disk.push('returned');
    // A power loss can't bring the token it replaced back.
    expect(disk).toEqual([
      expect.stringMatching(/^fsync tokens\.json\..+\.partial$/) as string,
      'rename to tokens.json',
      ...(process.platform === 'win32' ? [] : [`fsync ${path.basename(dir)}`]),
      'returned',
    ]);
  });

  it('says a token it knew is revoked once it expires, and never one it never made', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const id = tokens.clientOf(token)?.token ?? '';
    expect(tokens.revoked(id)).toBe(false);
    now += HOUR;
    expect(tokens.revoked(id)).toBe(true);
    // A caller the store didn't make (a test's) is no token of its own.
    expect(tokens.revoked('write-token')).toBe(false);
  });

  it('refuses a name that isn’t an id, and a token for no canvas', async () => {
    const tokens = await store();
    for (const name of ['', 'two words', '-flag', 'x'.repeat(33)]) {
      await expect(tokens.create({ name, canvases: [M1], access: 'write' })).rejects.toThrow(
        /name/,
      );
    }
    await expect(tokens.create({ name: 'none', canvases: [], access: 'write' })).rejects.toThrow(
      /canvas/,
    );
  });

  it('keeps when each token was last used', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    now += 5 * 60 * 1000;
    tokens.clientOf(token);
    await tokens.flush();
    const kept = JSON.parse(await readFile(file, 'utf8')) as {
      tokens: Record<string, { lastUsed?: number }>;
    };
    expect(kept.tokens[sha256(token)]?.lastUsed).toBe(now);
  });

  it('writes a token’s last use down once a minute while it is used, however often', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const lastUsed = async () =>
      (
        JSON.parse(await readFile(file, 'utf8')) as {
          tokens: Record<string, { lastUsed?: number }>;
        }
      ).tokens[sha256(token)]?.lastUsed;
    const first = now;
    tokens.clientOf(token);
    await vi.waitFor(async () => {
      expect(await lastUsed()).toBe(first);
    });
    // Used every 30 seconds: written down again a minute after it last was.
    now += 30 * 1000;
    tokens.clientOf(token);
    now += 30 * 1000;
    tokens.clientOf(token);
    await vi.waitFor(async () => {
      expect(await lastUsed()).toBe(first + 60 * 1000);
    });
  });

  it('forgets expired tokens, and reads a file of another version, or not its own, as none', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    now += 2 * HOUR;
    await tokens.create({ name: 'later', canvases: [M1], access: 'write' });
    const kept = JSON.parse(await readFile(file, 'utf8')) as { tokens: Record<string, unknown> };
    expect(Object.keys(kept.tokens)).toEqual([expect.not.stringMatching(sha256(token))]);

    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A file it can't read as its own is set aside, as it was, and said.
    for (const text of ['not json', JSON.stringify({ version: 1, tokens: kept.tokens })]) {
      await writeFile(file, text);
      expect((await store()).clientOf('x')).toBeUndefined();
      const rejected = (await readdir(dir)).filter((name) => name.startsWith('tokens.rejected-'));
      expect(rejected).toHaveLength(1);
      expect(await readFile(path.join(dir, String(rejected[0])), 'utf8')).toBe(text);
      expect(said).toHaveBeenLastCalledWith(
        expect.stringContaining(path.join(dir, String(rejected[0]))),
      );
      await rm(path.join(dir, String(rejected[0])));
    }
    said.mockRestore();
    // One of its version whose tokens aren't right is its own: none of them is read.
    for (const text of [
      JSON.stringify({ version: 2, tokens: [] }),
      JSON.stringify({
        version: 2,
        tokens: {
          [sha256('x')]: {
            id: 'a',
            name: 'bad name',
            canvases: [M1],
            access: 'write',
            expires: now + HOUR,
          },
        },
      }),
      JSON.stringify({
        version: 2,
        tokens: {
          [sha256('x')]: {
            id: 'a',
            name: 'ok',
            canvases: ['nope'],
            access: 'write',
            expires: now + HOUR,
          },
        },
      }),
      JSON.stringify({
        version: 2,
        tokens: {
          [sha256('x')]: {
            id: 'a',
            name: 'ok',
            canvases: [M1],
            access: 'all',
            expires: now + HOUR,
          },
        },
      }),
      JSON.stringify({
        version: 2,
        tokens: {
          'not-a-hash': {
            id: 'a',
            name: 'ok',
            canvases: [M1],
            access: 'write',
            expires: now + HOUR,
          },
        },
      }),
    ]) {
      await writeFile(file, text);
      expect((await store()).clientOf('x')).toBeUndefined();
      expect(await readdir(dir)).toEqual(['tokens.json']);
    }
    // A token written as it writes them is read.
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        tokens: {
          [sha256('x')]: {
            id: 'a',
            name: 'ok',
            canvases: [M1],
            access: 'write',
            expires: now + HOUR,
          },
        },
      }),
    );
    expect((await store()).clientOf('x')).toEqual({
      kind: 'outside',
      token: 'a',
      name: 'ok',
      access: 'write',
      merge: true,
      canvases: [M1],
    });
  });

  it('writes back what a newer corrallm keeps in it that it doesn’t know, as it was', async () => {
    const kept = {
      id: 'a',
      name: 'ok',
      canvases: [M1],
      access: 'write',
      expires: now + HOUR,
      scopes: ['messages'],
    };
    await writeFile(
      file,
      JSON.stringify({ version: 2, tokens: { [sha256('x')]: kept }, created: { ok: [WORKER] } }),
    );
    const tokens = await store();
    expect(tokens.clientOf('x')?.name).toBe('ok');
    await tokens.create({ name: 'other', canvases: [M1], access: 'read' });
    const written = JSON.parse(await readFile(file, 'utf8')) as {
      tokens: Record<string, unknown>;
      created: unknown;
    };
    expect(written.created).toEqual({ ok: [WORKER] });
    expect(written.tokens[sha256('x')]).toEqual({ ...kept, lastUsed: now });
  });

  it.skipIf(!CAN_DENY)('never writes over a file it can’t read: it refuses to load', async () => {
    const first = await store();
    const token = await first.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const kept = await readFile(file, 'utf8');
    await chmod(file, 0);
    await expect(new TokenStore(file, clock).load()).rejects.toThrow(/EACCES/);
    await chmod(file, 0o600);
    expect(await readFile(file, 'utf8')).toBe(kept);
    expect((await store()).clientOf(token)?.name).toBe('orchestrator');
  });
});

/*
 * `corrallm token renew|revoke` (Build Plan B30) against the store the owner of the profile keeps:
 * a renewal is a new value for the live token of a name, with its canvases and access; a revoke
 * removes it. Either takes effect at once, is forced to disk first, and ends a call still going.
 */
describe('TokenStore: renewing and revoking by name', () => {
  it('renews the live token of a name: a new value, the same canvases and access, for the hours asked', async () => {
    const tokens = await store();
    const old = await tokens.create({
      name: 'orchestrator',
      canvases: [M1, WORKER],
      access: 'read',
      hours: 12,
    });
    const oldId = tokens.clientOf(old)?.token ?? '';
    const heard: string[] = [];
    tokens.onRevoke((id) => heard.push(id));
    now += HOUR;
    // Its last use, written down as it was looked up, is on disk first.
    await tokens.flush();
    disk.length = 0;
    const renewed = await tokens.renew('orchestrator', 2);
    disk.push('returned');
    expect(renewed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(renewed).not.toBe(old);
    // Forced to disk before it returns: no power loss brings the old one back.
    expect(disk[0]).toMatch(/^fsync tokens\.json\..+\.partial$/);
    expect(disk).toContain('rename to tokens.json');
    expect(disk.at(-1)).toBe('returned');
    expect(tokens.clientOf(old)).toBeUndefined();
    expect(tokens.revoked(oldId)).toBe(true);
    expect(heard).toEqual([oldId]);
    expect(tokens.clientOf(renewed ?? '')).toMatchObject({
      name: 'orchestrator',
      access: 'read',
      canvases: [M1, WORKER],
    });
    expect(tokens.grant('orchestrator')).toEqual({
      name: 'orchestrator',
      canvases: [M1, WORKER],
      access: 'read',
      expires: now + 2 * HOUR,
    });
    // By default for as long as a new token lasts: an hour.
    const again = await tokens.renew('orchestrator');
    expect(tokens.grant('orchestrator')?.expires).toBe(now + HOUR);
    expect(tokens.clientOf(renewed ?? '')).toBeUndefined();
    expect(tokens.clientOf(again ?? '')?.name).toBe('orchestrator');
    const kept = await readFile(file, 'utf8');
    for (const value of [old, renewed, again]) expect(kept).not.toContain(value);
  });

  it('renews a token made with --no-merge as one: it still can’t merge', async () => {
    const tokens = await store();
    await tokens.create({ name: 'builder', canvases: [M1], access: 'write-no-merge' });
    const renewed = await tokens.renew('builder', 3);
    expect(tokens.grant('builder')).toEqual({
      name: 'builder',
      canvases: [M1],
      access: 'write-no-merge',
      expires: now + 3 * HOUR,
    });
    expect(tokens.clientOf(renewed ?? '')).toMatchObject({ access: 'write', merge: false });
    expect((await store()).grant('builder')?.access).toBe('write-no-merge');
  });

  it('renews no token of a name that has none live: never made, expired or revoked', async () => {
    const tokens = await store();
    expect(await tokens.renew('nobody')).toBeUndefined();
    await tokens.create({ name: 'late', canvases: [M1], access: 'write' });
    now += HOUR;
    expect(await tokens.renew('late')).toBeUndefined();
    await tokens.create({ name: 'gone', canvases: [M1], access: 'write' });
    expect(await tokens.revoke('gone')).toBe(true);
    expect(await tokens.renew('gone')).toBeUndefined();
    await tokens.create({ name: 'live', canvases: [M1], access: 'write' });
    await expect(tokens.renew('live', 13)).rejects.toThrow(/1 to 12 hours/);
  });

  it('revokes the live token of a name at once, forced to disk, ending a call it has going', async () => {
    const tokens = await store();
    const token = await tokens.create({ name: 'orchestrator', canvases: [M1], access: 'write' });
    const other = await tokens.create({ name: 'other', canvases: [M1], access: 'write' });
    const id = tokens.clientOf(token)?.token ?? '';
    const heard: string[] = [];
    tokens.onRevoke((revoked) => heard.push(revoked));
    await tokens.flush();
    disk.length = 0;
    expect(await tokens.revoke('orchestrator')).toBe(true);
    disk.push('returned');
    expect(disk[0]).toMatch(/^fsync tokens\.json\..+\.partial$/);
    expect(disk.at(-1)).toBe('returned');
    expect(heard).toEqual([id]);
    expect(tokens.revoked(id)).toBe(true);
    expect(tokens.clientOf(token)).toBeUndefined();
    expect(tokens.grant('orchestrator')).toBeUndefined();
    expect(tokens.clientOf(other)?.name).toBe('other');
    // Gone across a restart too, and a second revoke finds nothing.
    expect((await store()).clientOf(token)).toBeUndefined();
    expect(await tokens.revoke('orchestrator')).toBe(false);
    expect(await tokens.revoke('nobody')).toBe(false);
  });

  it('knows a token it made that no longer works: replaced, revoked or expired, never a stranger', async () => {
    const tokens = await store();
    const replaced = await tokens.create({ name: 'a', canvases: [M1], access: 'write' });
    const renewed = await tokens.renew('a', 12);
    const revoked = await tokens.create({ name: 'b', canvases: [M1], access: 'write' });
    await tokens.revoke('b');
    const expiring = await tokens.create({ name: 'c', canvases: [M1], access: 'write' });
    expect(tokens.stale(replaced)).toBe(true);
    expect(tokens.stale(revoked)).toBe(true);
    expect(tokens.stale(expiring)).toBe(false);
    expect(tokens.stale(renewed ?? '')).toBe(false);
    expect(tokens.stale('never-made')).toBe(false);
    now += HOUR;
    expect(tokens.stale(expiring)).toBe(true);
    // Pruned as the store is written again, it is still known for what it was.
    await tokens.create({ name: 'd', canvases: [M1], access: 'write' });
    expect(tokens.stale(expiring)).toBe(true);
  });
});
