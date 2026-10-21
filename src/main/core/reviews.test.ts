import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { toFile } from '../../shared/model/file';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { Change } from '../../shared/api/topics';
import type { OpName } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { FakeConnector } from '../sessions/fake';
import type { Caller, OutsideCaller } from './caller';
import type { WatchFolder } from './canvas/watch';
import { createCore } from './core';
import type { Core } from './core';
import { mintTrustedPath } from './host';
import type { HostServices } from './host';
import { keepCanvases, readOnDisk, refuseWrites } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * File reviews, end to end (Core Server §5.10, B9 Design §5): a canvas's file changed on disk is
 * never read over what the core keeps of it. The core checks it as the canvas opens, through its
 * folder's watch while it is open, as a window showing it gains focus, and before each save, and
 * raises one review for you at a time, which you apply or keep. On a profile keeping two canvases,
 * each in a file of its own with a project folder: `team` (agents `lead` and `worker`, linked) and
 * `other` (agent `solo`). The folders' watch is off but where a test turns it on, so that each
 * other check is seen alone.
 */

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const TEAM = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01' as CanvasId;
const OTHER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d02' as CanvasId;
const YOU = CALLERS.you;
const TOKEN: OutsideCaller = {
  ...(CALLERS['outside-write'] as OutsideCaller),
  canvases: [TEAM, OTHER],
};
/** A watch that never says anything changed: only the other checks look. */
const NO_WATCH: WatchFolder = () => ({ close: () => undefined });

const agent = (id: string, x = 0, more: object = {}) => ({
  id,
  kind: 'agent',
  label: id.charAt(0).toUpperCase() + id.slice(1),
  position: { x, y: 0 },
  adapter: 'codex',
  connection: 'codex.app-server',
  ...more,
});
const team = (...more: object[]) => ({
  format: 'corrallm',
  version: 2,
  id: TEAM,
  nodes: [
    agent('lead', 0, { role: 'Leads the team.' }),
    agent('worker', 400, { queue: [{ id: 'hello', message: 'Say hello' }] }),
    ...more,
  ],
  links: [{ agents: ['lead', 'worker'] }],
});
const other = (...more: object[]) => ({
  format: 'corrallm',
  version: 2,
  id: OTHER,
  nodes: [agent('solo'), ...more],
  links: [],
});
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

let profile: string;
let core: Core;
let files: Record<'team' | 'other', string>;
/** The file the Open dialog picks next: none, cancelled. */
let picked: string | undefined;
const host: HostServices = {
  ...NO_DESKTOP,
  pickCanvasToOpen: () => {
    const file = picked;
    picked = undefined;
    return Promise.resolve(file === undefined ? null : mintTrustedPath(file));
  },
};

/** The core on the profile: its folders' watch fs.watch's (`'fs'`), or none. */
async function start(watch: 'fs' | 'none' = 'none'): Promise<Core> {
  return createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      limitsClock: (() => {
        let now = 0;
        return () => (now += 1000);
      })(),
      ...(watch === 'fs' ? {} : { watchFolder: NO_WATCH }),
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    host,
  );
}
/** The core stopped and started again, as a restart does. */
async function restart(watch?: 'fs' | 'none'): Promise<void> {
  await core.close();
  core = await start(watch);
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-reviews-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  files = { team: path.join(profile, 'team.corral'), other: path.join(profile, 'other.corral') };
  await writeFile(files.team, JSON.stringify(team()));
  await writeFile(files.other, JSON.stringify(other()));
  await keepCanvases(profile, {
    [OTHER]: { file: files.other, project },
    [TEAM]: { file: files.team, project },
  });
  core = await start();
});
afterEach(async () => {
  await core.close();
  await chmod(files.team, 0o644).catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

function call(name: OpName, args: object, caller: Caller = YOU): Promise<OpResult<unknown>> {
  return core.call(name, args, caller);
}
async function applied(
  name: OpName,
  args: object,
  caller: Caller = YOU,
): Promise<Record<string, unknown>> {
  const result = await call(name, args, caller);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value as Record<string, unknown>;
}
/** The file reviews waiting on a canvas, as `needs` gives them to `caller`. */
async function reviewsOf(canvas: CanvasId, caller: Caller = YOU): Promise<NeedsItem[]> {
  const { items } = (await applied('needs', { canvas }, caller)) as { items: NeedsItem[] };
  return items.filter((item) => item.kind === 'file');
}
/** The one review waiting on a canvas. */
async function reviewOf(canvas: CanvasId): Promise<NeedsItem> {
  const reviews = await reviewsOf(canvas);
  expect(reviews).toHaveLength(1);
  const [review] = reviews;
  if (review === undefined) throw new Error('No review is open.');
  return review;
}
/** The labels of a canvas's agents and frames, as canvas.get gives them to you. */
async function labelsOf(canvas: CanvasId): Promise<string[]> {
  const { nodes } = (await applied('canvas.get', { canvas })) as {
    nodes: { data: { label: string } }[];
  };
  return nodes.map(({ data }) => data.label);
}
/** Answers a review as `caller`. */
function answer(canvas: CanvasId, to: string, choice: string, caller: Caller = YOU) {
  return call('reply', { canvas, to, answer: { choice } }, caller);
}
/** A review's row, as kept. */
const rowOf = (id: string) =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare('SELECT file_hash, outcome, settled_by FROM file_review WHERE id = ?')
      .get(id.slice('file/'.length)),
  );
/** What the profile keeps of a canvas's document's hashes. */
const hashesOf = (canvas: CanvasId) =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare('SELECT saved_hash, file_hash, writing_hash FROM document WHERE canvas_id = ?')
      .get(canvas),
  );
/** Shows `canvas` in your window, its check as it opens done. */
async function show(canvas: CanvasId): Promise<void> {
  await applied('window.show', { canvas });
  await core.focused(1);
}

describe('a file review', () => {
  it('is raised as a canvas whose file changed while corrallm was closed opens: what corrallm kept stays the canvas', async () => {
    await core.engines.open(TEAM);
    await applied('canvas.rename', { canvas: TEAM, node: 'lead', label: 'Head' });
    await restart();
    const theirs = JSON.stringify(team(agent('tester', 800)));
    await writeFile(files.team, theirs);

    await core.engines.open(TEAM);

    const review = await reviewOf(TEAM);
    expect(review).toMatchObject({
      id: expect.stringMatching(/^file\/[0-9a-f-]{36}$/) as string,
      canvas: TEAM,
      kind: 'file',
      for: 'you',
      by: ['you'],
      title: 'team.corral changed on disk',
      detail: expect.stringMatching(
        /^The file adds Tester; changes Head \(renamed Lead\)\. Apply .*Keep .*save/,
      ) as string,
      choices: [
        { value: 'apply', humanOnly: expect.any(String) as string },
        { value: 'keep', humanOnly: expect.any(String) as string },
      ],
      answerIn: 'api',
    });
    expect(review).not.toHaveProperty('agent');
    expect(await labelsOf(TEAM)).toEqual(['Head', 'Worker']);
    expect(core.engines.canvas(TEAM)?.document.nodes.map(({ id }) => id)).toEqual([
      'lead',
      'worker',
    ]);
    // No file text is kept: its hash, and what it changes.
    expect(rowOf(review.id)).toEqual({
      file_hash: sha256(theirs),
      outcome: null,
      settled_by: null,
    });
  });

  it('is raised as a canvas whose file stopped being a canvas opens, from what corrallm kept', async () => {
    await core.engines.open(TEAM);
    await restart();
    await writeFile(files.team, 'Remember the milk');

    await core.engines.open(TEAM);

    expect((await reviewOf(TEAM)).detail).toMatch(/^The file isn’t a canvas this corrallm reads/);
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Worker']);
  });

  it('is raised as a canvas the core doesn’t run is read again, its file changed meanwhile', async () => {
    expect(await labelsOf(OTHER)).toEqual(['Solo']);
    await restart();
    await writeFile(files.other, JSON.stringify(other(agent('second', 400))));

    expect(await labelsOf(OTHER)).toEqual(['Solo']);
    expect((await reviewOf(OTHER)).detail).toMatch(/^The file adds Second\./);
  });

  it('is raised as you open a canvas’s file changed since corrallm last read it', async () => {
    expect(await labelsOf(OTHER)).toEqual(['Solo']);
    await writeFile(files.other, JSON.stringify(other(agent('second', 400))));
    picked = files.other;

    expect(await applied('canvas.open', {})).toMatchObject({ canvas: OTHER });

    expect(await labelsOf(OTHER)).toEqual(['Solo']);
    expect(await reviewOf(OTHER)).toMatchObject({
      title: 'other.corral changed on disk',
      detail: expect.stringMatching(/^The file adds Second\./) as string,
    });
  });

  it('isn’t raised by a file as corrallm last read or wrote it, nor shown to tokens', async () => {
    await core.engines.open(TEAM);
    await applied('canvas.rename', { canvas: TEAM, node: 'lead', label: 'Head' });
    await applied('canvas.save', { canvas: TEAM });
    await restart();
    await core.engines.open(TEAM);
    await show(OTHER);
    expect(await reviewsOf(TEAM)).toEqual([]);
    expect(await reviewsOf(OTHER)).toEqual([]);

    await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
    await applied('canvas.rename', { canvas: TEAM, node: 'worker', label: 'Builder' });
    expect(await call('canvas.save', { canvas: TEAM })).toMatchObject({ ok: false });
    expect(await reviewsOf(TEAM)).toHaveLength(1);
    expect(await reviewsOf(TEAM, TOKEN)).toEqual([]);
  });

  it('is checked as a window showing the canvas gains focus', async () => {
    await show(OTHER);
    await writeFile(files.other, JSON.stringify(other(agent('second', 400))));
    expect(await reviewsOf(OTHER)).toEqual([]);

    await core.focused(1);
    expect(await reviewsOf(OTHER)).toHaveLength(1);
    // A window that shows nothing checks nothing.
    await core.focused(9);
  });

  it('is checked before a save, which it refuses while it is open; Keep lets the next save write corrallm’s canvas over the file', async () => {
    await core.engines.open(TEAM);
    await applied('canvas.rename', { canvas: TEAM, node: 'worker', label: 'Builder' });
    const theirs = JSON.stringify(team(agent('tester', 800)));
    await writeFile(files.team, theirs);

    const refused = await call('canvas.save', { canvas: TEAM });
    const review = await reviewOf(TEAM);
    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence: `team.corral changed on disk since corrallm last read or wrote it: apply it or keep corrallm’s canvas (${review.id}, in Needs you) before saving it.`,
      },
    });
    expect(await call('canvas.save', { canvas: TEAM })).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    expect(await readFile(files.team, 'utf8')).toBe(theirs);

    expect(await answer(TEAM, review.id, 'keep')).toEqual({
      ok: true,
      value: { outcome: 'kept', revs: {} },
    });
    expect(rowOf(review.id)).toMatchObject({ outcome: 'kept', settled_by: 'you' });
    expect(await reviewsOf(TEAM)).toEqual([]);
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Builder']);
    await applied('canvas.save', { canvas: TEAM });
    const saved = await readFile(files.team, 'utf8');
    expect((JSON.parse(saved) as { nodes: { label: string }[] }).nodes.map((n) => n.label)).toEqual(
      ['Lead', 'Builder'],
    );
    expect(hashesOf(TEAM)).toEqual({
      saved_hash: sha256(saved),
      file_hash: sha256(saved),
      writing_hash: null,
    });
    // Answered once.
    expect(await answer(TEAM, review.id, 'apply')).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/settled already/) as string },
    });
  });

  it('kept, raises nothing again for the bytes kept, until corrallm writes the file over them', async () => {
    await show(TEAM);
    const theirs = JSON.stringify(team(agent('tester', 800)));
    await writeFile(files.team, theirs);
    await core.focused(1);
    const review = await reviewOf(TEAM);
    await answer(TEAM, review.id, 'keep');

    await core.focused(1);
    expect(await reviewsOf(TEAM)).toEqual([]);
    await restart();
    await show(TEAM);
    expect(await reviewsOf(TEAM)).toEqual([]);

    // Saved over, the same bytes written again are another change to review.
    await applied('canvas.save', { canvas: TEAM });
    await writeFile(files.team, theirs);
    await core.focused(1);
    expect((await reviewOf(TEAM)).id).not.toBe(review.id);
  });

  it('is applied as your change: the file’s canvas, its hashes and the review’s settlement in one commit', async () => {
    await core.engines.open(TEAM);
    await applied('canvas.rename', { canvas: TEAM, node: 'worker', label: 'Builder' });
    const theirs = JSON.stringify(
      team(agent('tester', 800, { queue: [{ id: 'check', message: 'Check it' }] })),
    );
    await writeFile(files.team, theirs);
    await call('canvas.save', { canvas: TEAM });
    const review = await reviewOf(TEAM);

    // A write that fails keeps nothing of it: the canvas as it was, the review open.
    const release = refuseWrites(profile, 'file_review', 'The disk is full.');
    try {
      expect(await answer(TEAM, review.id, 'apply')).toMatchObject({ ok: false });
    } finally {
      release();
    }
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Builder']);
    expect((await reviewOf(TEAM)).id).toBe(review.id);

    const result = await answer(TEAM, review.id, 'apply');
    const { rev } = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT rev FROM document WHERE canvas_id = ?').get(TEAM),
    ) as { rev: number };
    expect(result).toEqual({
      ok: true,
      value: { outcome: 'applied', revs: { [`canvas:${TEAM}`]: rev } },
    });
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Worker', 'Tester']);
    // The run follows it.
    expect(core.engines.canvas(TEAM)?.document.nodes.map(({ id }) => id)).toEqual([
      'lead',
      'worker',
      'tester',
    ]);
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare('SELECT op, by_party FROM revision WHERE canvas_id = ? AND rev = ?')
          .get(TEAM, rev),
      ),
    ).toEqual({ op: 'file.apply', by_party: 'you' });
    expect(rowOf(review.id)).toMatchObject({ outcome: 'applied', settled_by: 'you' });
    expect(hashesOf(TEAM)).toMatchObject({ file_hash: sha256(theirs), writing_hash: null });
    // Not edited: the canvas is its file's (said within EDITED_EVERY of a commit).
    await vi.waitFor(async () => {
      const { items } = (await applied('canvas.list', {})) as {
        items: { canvas: string; edited: boolean }[];
      };
      expect(items.find((item) => item.canvas === TEAM)?.edited).toBe(false);
    });
    expect(await reviewsOf(TEAM)).toEqual([]);
  });

  it('is superseded as Apply finds the file changed since, by one for what is there now', async () => {
    await show(TEAM);
    await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
    await core.focused(1);
    const first = await reviewOf(TEAM);
    await writeFile(files.team, JSON.stringify(team(agent('builder', 800))));

    const result = await answer(TEAM, first.id, 'apply');

    const now = await reviewOf(TEAM);
    expect(result).toEqual({
      ok: true,
      value: { outcome: 'superseded', raised: now.id, revs: {} },
    });
    expect(now.detail).toMatch(/^The file adds Builder\./);
    expect(rowOf(first.id)).toMatchObject({ outcome: 'superseded', settled_by: 'corrallm' });
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Worker']);
  });

  it('is one at a time: a change after it supersedes it, and a file back as corrallm has it settles it', async () => {
    await show(TEAM);
    await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
    await core.focused(1);
    const first = await reviewOf(TEAM);
    await writeFile(files.team, JSON.stringify(team(agent('builder', 800))));
    await core.focused(1);
    const second = await reviewOf(TEAM);
    expect(second.id).not.toBe(first.id);
    expect(rowOf(first.id)).toMatchObject({ outcome: 'superseded', settled_by: 'corrallm' });

    await writeFile(files.team, JSON.stringify(team()));
    await core.focused(1);
    expect(await reviewsOf(TEAM)).toEqual([]);
    expect(rowOf(second.id)).toMatchObject({ outcome: 'superseded', settled_by: 'corrallm' });
  });

  it('says a file that isn’t a canvas this corrallm reads isn’t one, and offers only Keep', async () => {
    await show(TEAM);
    await writeFile(files.team, 'Remember the milk');
    await core.focused(1);
    const review = await reviewOf(TEAM);
    expect(review.detail).toBe(
      'The file isn’t a canvas this corrallm reads (this is not a corrallm canvas). Keep corrallm’s canvas, and its next save writes it over the file.',
    );
    expect(review.choices.map(({ value }) => value)).toEqual(['keep']);
    expect(await answer(TEAM, review.id, 'apply')).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(await answer(TEAM, review.id, 'keep')).toMatchObject({ ok: true });
  });

  it('isn’t raised for a file that is gone, or can’t be read', async () => {
    await show(TEAM);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(files.team, 0o000);
      await core.focused(1);
      expect(await reviewsOf(TEAM)).toEqual([]);
      await chmod(files.team, 0o644);
    }
    await rm(files.team);
    await core.focused(1);
    expect(await reviewsOf(TEAM)).toEqual([]);
  });

  it('isn’t raised by a file holding the canvas corrallm has, written another way', async () => {
    await show(TEAM);
    const text = JSON.stringify(team(), null, 4);
    await writeFile(files.team, text);
    await core.focused(1);
    expect(await reviewsOf(TEAM)).toEqual([]);
    // Its bytes are the file's now: nothing is edited, and nothing raised as it opens again.
    expect(hashesOf(TEAM)).toMatchObject({ file_hash: sha256(text) });
    await restart();
    await show(TEAM);
    expect(await reviewsOf(TEAM)).toEqual([]);
  });

  it('is in the canvas’s needs topic for you as it is raised and settled, and in no token’s', async () => {
    await show(TEAM);
    const latest = new Map<string, NeedsItem[]>();
    const stops: (() => void)[] = [];
    for (const [who, caller] of [
      ['you', YOU],
      ['token', TOKEN],
    ] as const) {
      const { snapshot, stop } = await core.topics.follow(
        caller,
        `needs:${TEAM}`,
        (batch: Change[]) => {
          for (const change of batch) {
            if ('replace' in change) {
              latest.set(who, (change.replace as { items: NeedsItem[] }).items);
            }
          }
        },
      );
      latest.set(who, (snapshot.state as { items: NeedsItem[] }).items);
      stops.push(stop);
    }
    try {
      await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
      await core.focused(1);
      const review = await reviewOf(TEAM);
      await vi.waitFor(() => {
        expect(latest.get('you')?.map(({ id }) => id)).toEqual([review.id]);
      });
      await answer(TEAM, review.id, 'keep');
      await vi.waitFor(() => {
        expect(latest.get('you')).toEqual([]);
      });
      expect(latest.get('token')).toEqual([]);
    } finally {
      for (const stop of stops) stop();
    }
  });
});

describe('a canvas file’s folder, watched while the canvas is open', () => {
  it('raises a review as the file changes, one open at a time, and none for corrallm’s own saves', async () => {
    await restart('fs');
    await core.engines.open(TEAM);
    await applied('canvas.rename', { canvas: TEAM, node: 'worker', label: 'Builder' });
    await applied('canvas.save', { canvas: TEAM });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await reviewsOf(TEAM)).toEqual([]);

    await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
    await vi.waitFor(
      async () => {
        expect(await reviewsOf(TEAM)).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    const first = await reviewOf(TEAM);
    await writeFile(files.team, JSON.stringify(team(agent('scout', 800))));
    await vi.waitFor(
      async () => {
        expect((await reviewOf(TEAM)).detail).toMatch(/Scout/);
      },
      { timeout: 5000 },
    );
    expect(rowOf(first.id)).toMatchObject({ outcome: 'superseded' });
  });

  it('stops once the canvas closes: a change meanwhile is raised as it opens again', async () => {
    await restart('fs');
    await core.engines.open(TEAM);
    await applied('canvas.close', { canvas: TEAM });
    await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT count(*) AS n FROM file_review WHERE canvas_id = ?').get(TEAM),
      ),
    ).toEqual({ n: 0 });

    await core.engines.open(TEAM);
    expect(await reviewsOf(TEAM)).toHaveLength(1);
  });
});

it('adopts the live document as the saved baseline and publishes clean meta on both topics', async () => {
  await core.engines.open(TEAM);
  await show(TEAM);
  await applied('canvas.save', { canvas: TEAM });
  const old = await readFile(files.team, 'utf8');
  await applied('canvas.rename', { canvas: TEAM, node: 'lead', label: 'Head' });
  const open = core.engines.canvas(TEAM);
  if (!open) throw new Error('No open canvas');
  const text = toFile(open.document);
  await vi.waitFor(async () => {
    const { items } = (await applied('canvas.list', {})) as {
      items: { canvas: string; edited: boolean }[];
    };
    expect(items.find((item) => item.canvas === TEAM)?.edited).toBe(true);
  });
  let canvasEdited: boolean | undefined;
  let listEdited: boolean | undefined;
  const canvasFeed = await core.topics.follow(YOU, `canvas:${TEAM}`, (changes) => {
    for (const change of changes) {
      const rows =
        'replace' in change
          ? (change.replace as Record<string, { edited: boolean }>)
          : (change.set as Record<string, { edited: boolean }>);
      if (rows.meta) canvasEdited = rows.meta.edited;
    }
  });
  const listFeed = await core.topics.follow(YOU, 'canvases', (changes) => {
    for (const change of changes)
      if ('replace' in change) {
        const { items } = change.replace as { items: { canvas: string; edited: boolean }[] };
        listEdited = items.find((item) => item.canvas === TEAM)?.edited;
      }
  });
  try {
    await writeFile(files.team, text);
    await core.focused(1);
    await vi.waitFor(() => {
      expect(canvasEdited).toBe(false);
      expect(listEdited).toBe(false);
    });
    expect(hashesOf(TEAM)).toMatchObject({ saved_hash: sha256(text), file_hash: sha256(text) });
    await writeFile(files.team, old);
    await core.focused(1);
    expect(await reviewsOf(TEAM)).toHaveLength(1);
  } finally {
    canvasFeed.stop();
    listFeed.stop();
  }
});

it('does not apply a review cancelled while its file is being read', async () => {
  await show(TEAM);
  await writeFile(files.team, JSON.stringify(team(agent('tester', 800))));
  await core.focused(1);
  const review = await reviewOf(TEAM);
  const read = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const blocked = vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (args[0] === files.team) {
      entered.resolve(undefined);
      await release.promise;
    }
    return read(...args);
  });
  const abort = new AbortController();
  const request = '6a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a73';
  const args = { canvas: TEAM, to: review.id, answer: { choice: 'apply' }, request };
  const pending = core.call('reply', args, YOU, abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve(undefined);
  try {
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: 'The call was cancelled.' },
    });
    expect(await labelsOf(TEAM)).toEqual(['Lead', 'Worker']);
    expect((await reviewOf(TEAM)).id).toBe(review.id);
    // A cancelled attempt was not cached: the retry can apply it.
    expect(await core.call('reply', args, YOU)).toMatchObject({
      ok: true,
      value: { outcome: 'applied' },
    });
  } finally {
    blocked.mockImplementation(read);
  }
});
