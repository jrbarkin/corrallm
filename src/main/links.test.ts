import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkOpener } from './links';
import type { LinkAnswer, LinkOpenerDeps } from './links';

/** Whether a file's permissions can keep its owner from reading it: not on Windows, nor as root. */
const CAN_DENY = process.platform !== 'win32' && process.getuid?.() !== 0;

/** The window the dialog belongs to, by its id. */
let nextWindow = 0;
const renderer = () => ++nextWindow;

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-links-'));
  file = path.join(dir, 'links.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An opener whose dialog answers `answers` in turn, and which records what it opened. */
function opener(...answers: LinkAnswer[]) {
  const ask = vi.fn<LinkOpenerDeps['ask']>(() =>
    Promise.resolve(answers.shift() ?? { open: false, always: false }),
  );
  const openExternal = vi.fn<LinkOpenerDeps['openExternal']>(() => Promise.resolve());
  const links = new LinkOpener({ file, ask, openExternal });
  return { links, ask, openExternal };
}

describe('LinkOpener', () => {
  it('asks before opening a link, naming its site, and opens the normalized URL', async () => {
    const { links, ask, openExternal } = opener({ open: true, always: false });
    const contents = renderer();
    expect(await links.open(contents, 'https://Docs.Example.com/a b')).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      contents,
      'docs.example.com',
      'https://docs.example.com/a%20b',
    );
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/a%20b');
  });

  it('opens nothing when the user says no, and asks again next time', async () => {
    const { links, ask, openExternal } = opener({ open: false, always: false });
    expect(await links.open(renderer(), 'https://docs.example.com/')).toBe(false);
    expect(await links.open(renderer(), 'https://docs.example.com/')).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('remembers "Always for this site", by origin, across restarts', async () => {
    const first = opener({ open: true, always: true });
    await first.links.open(renderer(), 'https://docs.example.com/a');
    await first.links.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sites: ['https://docs.example.com'],
    });

    const later = opener();
    expect(await later.links.open(renderer(), 'https://docs.example.com/b')).toBe(true);
    expect(later.ask).not.toHaveBeenCalled();
    expect(later.openExternal).toHaveBeenCalledWith('https://docs.example.com/b');
    // Another port, scheme or host is another site.
    await later.links.open(renderer(), 'https://docs.example.com:8443/b');
    await later.links.open(renderer(), 'https://api.docs.example.com/b');
    expect(later.ask).toHaveBeenCalledTimes(2);
  });

  it('opens allowlisted sites without asking', async () => {
    const { links, ask, openExternal } = opener();
    expect(await links.open(renderer(), 'https://github.com/owner/repo')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/owner/repo');
  });

  it('asks for http only to this machine, and refuses every other kind of link unasked', async () => {
    const { links, ask, openExternal } = opener({ open: true, always: false });
    expect(await links.open(renderer(), 'http://localhost:5173/')).toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.anything(), 'localhost:5173', 'http://localhost:5173/');
    for (const raw of [
      'http://docs.example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@docs.example.com/',
      'app://main_window/index.html',
    ]) {
      expect(await links.open(renderer(), raw)).toBe(false);
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('asks one question at a time: links clicked meanwhile are dropped', async () => {
    let answer: (value: LinkAnswer) => void = () => undefined;
    const ask = vi.fn(
      () =>
        new Promise<LinkAnswer>((resolve) => {
          answer = resolve;
        }),
    );
    const openExternal = vi.fn(() => Promise.resolve());
    const links = new LinkOpener({ file, ask, openExternal });
    const contents = renderer();
    const asked = links.open(contents, 'https://one.example.com/');
    await vi.waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(await links.open(contents, 'https://two.example.com/')).toBe(false);
    answer({ open: true, always: false });
    expect(await asked).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://one.example.com/');
  });

  it('ignores a remembered file that is not right, and what in it is not a site', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sites: ['https://docs.example.com', 'http://evil.example', 'javascript:x', 7],
      }),
    );
    const { links, ask } = opener();
    await links.open(renderer(), 'https://docs.example.com/');
    await links.open(renderer(), 'http://evil.example/');
    expect(ask).not.toHaveBeenCalled();

    // One it can't read as its own is set aside, as it was, and said.
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const text of ['not json', JSON.stringify({ version: 2, sites: [] })]) {
      await rm(dir, { recursive: true });
      await mkdir(dir);
      await writeFile(file, text);
      const fresh = opener({ open: true, always: true });
      await fresh.links.open(renderer(), 'https://docs.example.com/');
      expect(fresh.ask).toHaveBeenCalledTimes(1);
      const rejected = (await readdir(dir)).filter((name) => name !== 'links.json');
      expect(rejected).toEqual([expect.stringMatching(/^links\.rejected-.+\.json$/)]);
      expect(await readFile(path.join(dir, String(rejected[0])), 'utf8')).toBe(text);
      expect(said).toHaveBeenLastCalledWith(
        expect.stringContaining(path.join(dir, String(rejected[0]))),
      );
    }
    said.mockRestore();
  });

  it('writes back what a newer corrallm keeps in it that it doesn’t know, as it was', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sites: ['https://docs.example.com'],
        never: ['https://evil.example.com'],
      }),
    );
    const { links } = opener({ open: true, always: true });
    await links.open(renderer(), 'https://one.example.com/');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sites: ['https://docs.example.com', 'https://one.example.com'],
      never: ['https://evil.example.com'],
    });
  });

  it.skipIf(!CAN_DENY)(
    'never writes over a file it can’t read, and reads it again next time',
    async () => {
      const kept = `${JSON.stringify({ version: 1, sites: ['https://docs.example.com'] })}\n`;
      await writeFile(file, kept);
      await chmod(file, 0);
      const { links, ask, openExternal } = opener({ open: true, always: true });
      await expect(links.open(renderer(), 'https://one.example.com/')).rejects.toThrow(/EACCES/);
      expect(ask).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      await chmod(file, 0o600);
      expect(await readFile(file, 'utf8')).toBe(kept);

      // Read once it can be.
      await links.open(renderer(), 'https://docs.example.com/');
      expect(ask).not.toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://docs.example.com/');
    },
  );
});
