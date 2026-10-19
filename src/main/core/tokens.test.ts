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
