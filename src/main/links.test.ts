import { existsSync } from 'node:fs';
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

/** A promise the test settles: `open` it to let what waits on it go on. */
function gate<T = void>() {
  let open: (value: T) => void = () => undefined;
  const shut = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

describe('the sites it remembers, taken back in Settings (B22a C5)', () => {
  const DOCS = 'https://docs.example.com';
  const PORTED = 'https://docs.example.com:8443';
  const LOCAL = 'http://localhost:5173';

  it('lists them in the order kept, and the built-in sites apart, as origins', async () => {
    await writeFile(file, JSON.stringify({ version: 1, sites: [PORTED, DOCS, LOCAL] }));
    const { links } = opener();
    expect(await links.sites()).toEqual([PORTED, DOCS, LOCAL]);
    expect(links.builtIn()).toEqual(['https://github.com']);
    // A remembered duplicate of a built-in site is listed as remembered too.
    await writeFile(file, JSON.stringify({ version: 1, sites: ['https://github.com'] }));
    expect(await opener().links.sites()).toEqual(['https://github.com']);
  });

  it('remembers at most the newest 500, even from a file that holds more', async () => {
    const sites = Array.from({ length: 501 }, (_, n) => `https://site-${String(n)}.example.com`);
    await writeFile(file, JSON.stringify({ version: 1, sites }));
    expect(await opener().links.sites()).toEqual(sites.slice(1));
  });

  it('forgets one origin exactly: a later click on it asks, the others open, across restarts', async () => {
    await writeFile(file, JSON.stringify({ version: 1, sites: [DOCS, PORTED, LOCAL], never: [1] }));
    const { links, ask, openExternal } = opener();
    const told = vi.fn();
    links.subscribe(told);
    await expect(links.forget(DOCS)).resolves.toBe(true);
    expect(told).toHaveBeenCalledOnce();
    // Forgetting opens nothing, asks nothing.
    expect(openExternal).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(await links.sites()).toEqual([PORTED, LOCAL]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sites: [PORTED, LOCAL],
      never: [1],
    });

    const later = opener();
    expect(await later.links.open(renderer(), 'https://docs.example.com/a')).toBe(false);
    expect(later.ask).toHaveBeenCalledOnce();
    expect(await later.links.open(renderer(), 'https://docs.example.com:8443/a')).toBe(true);
    expect(await later.links.open(renderer(), 'http://localhost:5173/a')).toBe(true);
    expect(later.ask).toHaveBeenCalledOnce();
  });

  it('forgets nothing for a site it doesn’t remember, writing nothing and telling no one', async () => {
    const layout = JSON.stringify({ version: 1, sites: [DOCS] });
    await writeFile(file, layout);
    const { links } = opener();
    const told = vi.fn();
    links.subscribe(told);
    await expect(links.forget(PORTED)).resolves.toBe(false);
    await expect(links.forget('https://github.com')).resolves.toBe(false);
    expect(await readFile(file, 'utf8')).toBe(layout);
    expect(told).not.toHaveBeenCalled();
  });

  it('tells its listeners when "Always for this site" remembers one', async () => {
    const { links } = opener({ open: true, always: true }, { open: true, always: false });
    const told = vi.fn();
    links.subscribe(told);
    await links.open(renderer(), 'https://docs.example.com/');
    expect(told).toHaveBeenCalledOnce();
    expect(await links.sites()).toEqual([DOCS]);
    await links.open(renderer(), 'https://one.example.com/');
    expect(told).toHaveBeenCalledOnce();
  });

  it('wins over a grant whose dialog opened before it: that click opens once, nothing is kept', async () => {
    const asked = gate<LinkAnswer>();
    const ask = vi.fn(() => asked.shut);
    const openExternal = vi.fn(() => Promise.resolve());
    const links = new LinkOpener({ file, ask, openExternal });
    const clicked = links.open(renderer(), 'https://docs.example.com/a');
    await vi.waitFor(() => {
      expect(ask).toHaveBeenCalledOnce();
    });
    // Nothing remembered yet, but a dialog is up for it: taking it back is no no-op.
    await expect(links.forget(DOCS)).resolves.toBe(true);
    asked.open({ open: true, always: true });
    expect(await clicked).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://docs.example.com/a');
    expect(await links.sites()).toEqual([]);
    expect(existsSync(file)).toBe(false);

    // A new Always, after it, is remembered again.
    ask.mockImplementation(() => Promise.resolve({ open: true, always: true }));
    await links.open(renderer(), 'https://docs.example.com/b');
    expect(await links.sites()).toEqual([DOCS]);
    // A dialog for another site is another site's.
    await expect(links.forget(PORTED)).resolves.toBe(false);
  });

  it('takes back a site whose save was still going when it was taken back', async () => {
    const saving = gate();
    const writes: string[] = [];
    const write = vi.fn(async (_file: string, text: string) => {
      writes.push(text);
      if (writes.length === 1) await saving.shut;
      await writeFile(file, text);
    });
    const ask = vi.fn(() => Promise.resolve({ open: true, always: true }));
    const links = new LinkOpener({ file, ask, openExternal: () => Promise.resolve(), write });
    const clicked = links.open(renderer(), 'https://docs.example.com/');
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });
    const forgot = links.forget(DOCS);
    saving.open();
    expect(await clicked).toBe(true);
    await expect(forgot).resolves.toBe(true);
    expect(await links.sites()).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, sites: [] });
  });

  it('refuses a forget it can’t save: still remembered, nothing told; a later one succeeds', async () => {
    await writeFile(file, JSON.stringify({ version: 1, sites: [DOCS] }));
    let fail = true;
    const write = vi.fn(async (_file: string, text: string) => {
      if (fail) throw new Error('No room.');
      await writeFile(file, text);
    });
    const links = new LinkOpener({
      file,
      ask: () => Promise.resolve({ open: false, always: false }),
      openExternal: () => Promise.resolve(),
      write,
    });
    const told = vi.fn();
    links.subscribe(told);
    await expect(links.forget(DOCS)).rejects.toMatchObject({ stage: 'write' });
    expect(await links.sites()).toEqual([DOCS]);
    expect(told).not.toHaveBeenCalled();
    fail = false;
    await expect(links.forget(DOCS)).resolves.toBe(true);
    expect(await links.sites()).toEqual([]);
  });

  it.skipIf(!CAN_DENY)(
    'refuses a forget, and its list, when its file can’t be read, never writing over it',
    async () => {
      const kept = `${JSON.stringify({ version: 1, sites: [DOCS] })}\n`;
      await writeFile(file, kept);
      await chmod(file, 0);
      const { links } = opener();
      try {
        await expect(links.sites()).rejects.toThrow(/EACCES/);
        await expect(links.forget(DOCS)).rejects.toMatchObject({ stage: 'read' });
      } finally {
        await chmod(file, 0o600);
      }
      expect(await readFile(file, 'utf8')).toBe(kept);
      expect(await links.sites()).toEqual([DOCS]);
    },
  );
});
