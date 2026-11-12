import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import type { AgentData, CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import type { PartyId } from '../../../shared/model/messages';
import { toRows } from '../../../shared/model/rows';
import * as wholeFile from '../../whole-file';
import { CanvasMemory } from '../../memory';
import { CATALOG } from '../../sessions/adapters';
import { mintTrustedPath } from '../host';
import type { Connection } from '../store/sqlite';
import type { Store } from '../store/store';
import { onDisk, openTestStore } from '../store/test-store';
import { Documents } from './documents';
import { FileReviews, itemOf, summarize } from './reviews';
import type { Told } from './reviews';

/*
 * File reviews in the canvas's document (B9 Design §5): what the core's own saves leave on disk is
 * never reviewed, however a save was cut short; what moves a canvas off the file a review is of
 * settles it; and what a review says a file changes.
 */

let profile: string;
let store: Store;
let memory: CanvasMemory;
let reviews: FileReviews;
let documents: Documents;
let disk: Connection;
/** What the reviews told: each canvas whose reviews changed, and by whom. */
let told: [CanvasId, PartyId][];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function agent(id: string, more: Partial<AgentData> = {}, x = 0): CanvasNode {
  return { id, type: 'agent', position: { x, y: 0 }, data: { label: cap(id), ...more } };
}
const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
function canvasOf(id: CanvasId, nodes: CanvasNode[] = [agent('lead'), agent('worker', {}, 400)]) {
  return { id, arrange: false, nodes, links: [] } satisfies CanvasDocument;
}

function compose(): void {
  memory = new CanvasMemory(store);
  told = [];
  reviews = new FileReviews({
    store,
    memory,
    changed: (canvas, by) => {
      told.push([canvas, by]);
    },
  });
  documents = new Documents({
    store,
    memory,
    catalog: CATALOG,

    reviews,
  });
}
/** Closes the store and opens it again, as the core does when it starts again. */
async function restart(): Promise<void> {
  await memory.flush();
  await store.close();
  store = await openTestStore(profile);
  compose();
}
/** A canvas kept in a file of its own, its text as toFile writes it. */
async function filed(document: CanvasDocument): Promise<string> {
  const file = path.join(profile, `${document.id}.corral`);
  await writeFile(file, toFile(document));
  await memory.setFile(document.id, mintTrustedPath(file));
  return file;
}
/** Commits `next` as the canvas's document, by you. */
async function commit(canvas: CanvasId, next: CanvasDocument): Promise<void> {
  await documents.change(canvas, {
    revision: { op: 'canvas.rename', by: 'you' },
    build: () => ({ next, result: undefined }),
    check: () => undefined,
    committing: () => undefined,
  });
}
const reviewRows = (canvas: CanvasId) =>
  disk
    .prepare('SELECT file_hash, outcome, settled_by FROM file_review WHERE canvas_id = ?')
    .all(canvas);

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-reviews-'));
  store = await openTestStore(profile);
  compose();
  disk = onDisk(profile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  disk.close();
  await memory.flush();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

describe('a save of the core’s own', () => {
  it('raises no review, wherever a crash cut it short', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    await documents.load(canvas);
    const ours = canvasOf(canvas, [agent('lead', { role: 'Leads.' }), agent('worker', {}, 400)]);
    await commit(canvas, ours);
    // Cut after its first step (the hash of what it writes committed), before the file was
    // written; then after the file was written, before its last commit.
    for (const written of [false, true]) {
      store.tx(() =>
        store
          .prepare('UPDATE document SET writing_hash = ? WHERE canvas_id = ?')
          .run(sha256(toFile(ours)), canvas),
      );
      if (written) await writeFile(file, toFile(ours));
      await restart();
      await documents.review(canvas);
      expect(reviewRows(canvas)).toEqual([]);
      expect(reviews.open(canvas)).toBeUndefined();
    }
    expect(documents.edited(canvas)).toBe(false);
    // And once it has gone on, from a check while the canvas is loaded.
    store.tx(() =>
      store
        .prepare('UPDATE document SET writing_hash = ? WHERE canvas_id = ?')
        .run(sha256('a save that never wrote'), canvas),
    );
    await restart();
    await documents.load(canvas);
    expect(reviewRows(canvas)).toEqual([]);
  });

  it('raises no review as its file is written, its folder told of it meanwhile', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    await documents.load(canvas);
    await commit(canvas, canvasOf(canvas, [agent('lead', { role: 'Leads.' })]));
    // A check asked for while the file is being written waits its turn, and finds it corrallm's.
    const writing = Promise.withResolvers<undefined>();
    const write = wholeFile.writeWhole;
    vi.spyOn(wholeFile, 'writeWhole').mockImplementationOnce(async (...args) => {
      await write(...args);
      await writing.promise;
    });
    const saving = documents.save(canvas, mintTrustedPath(file));
    const checking = documents.review(canvas);
    writing.resolve(undefined);
    await Promise.all([saving, checking]);
    expect(reviewRows(canvas)).toEqual([]);
  });
});

describe('a review open', () => {
  /** A canvas whose file changed on disk, reviewed: the review. */
  async function reviewed(canvas: CanvasId) {
    const file = await filed(canvasOf(canvas));
    await documents.load(canvas);
    await writeFile(file, toFile(canvasOf(canvas, [agent('lead'), agent('tester', {}, 800)])));
    await documents.review(canvas);
    const review = reviews.open(canvas);
    if (review === undefined) throw new Error('No review was raised.');
    return { file, review };
  }

  it('is settled superseded once the canvas is saved to another file', async () => {
    const canvas = newCanvasId();
    const { review } = await reviewed(canvas);
    told = [];
    await documents.save(canvas, mintTrustedPath(path.join(profile, 'elsewhere.corral')));
    expect(reviews.open(canvas)).toBeUndefined();
    expect(reviewRows(canvas)).toEqual([
      { file_hash: review.hash, outcome: 'superseded', settled_by: 'corrallm' },
    ]);
    expect(told).toEqual([[canvas, 'corrallm']]);
  });

  it('is settled superseded as the canvas’s edits are discarded, back to its file', async () => {
    const canvas = newCanvasId();
    const { review } = await reviewed(canvas);
    await documents.revert(canvas, { op: 'canvas.close', by: 'you' });
    expect(documents.live(canvas).document.nodes.map(({ id }) => id)).toEqual(['lead', 'tester']);
    expect(reviewRows(canvas)).toEqual([
      { file_hash: review.hash, outcome: 'superseded', settled_by: 'corrallm' },
    ]);
  });

  it('refuses a save over its file, which it leaves as it is', async () => {
    const canvas = newCanvasId();
    const { file, review } = await reviewed(canvas);
    await expect(documents.save(canvas, mintTrustedPath(file))).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringContaining(review.id) as string,
    });
    expect(reviews.open(canvas)?.id).toBe(review.id);
  });
});

describe('what a review says', () => {
  const canvas = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01' as CanvasId;
  /** The words of the review of a file holding `next`, over the canvas holding `live`. */
  function words(live: CanvasDocument, next: CanvasDocument): string | undefined {
    const summary = summarize('team.corral', 'abc', { document: live, rows: toRows(live) }, next);
    return itemOf({
      id: 'file/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02' as never,
      canvas,
      hash: 'def',
      summary,
      at: 1,
    }).detail;
  }

  it('names the agents the file adds, removes and changes, and what of them', () => {
    const live: CanvasDocument = {
      id: canvas,
      arrange: false,
      nodes: [
        { id: 'team', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team' } },
        agent('lead', { role: 'Leads.', queue: [{ id: 'one', message: 'One' }] }),
        agent('worker', { adapter: 'codex' }, 400),
        agent('gone', {}, 800),
      ],
      links: [{ source: 'lead', target: 'worker' }],
    };
    const next: CanvasDocument = {
      id: canvas,
      arrange: true,
      nodes: [
        agent('lead', { role: 'Decides.', queue: [{ id: 'one', message: 'Two' }] }),
        agent('worker', { adapter: 'codex', settings: { codex: { model: 'm2' } } }, 450),
        agent('new', {}, 1200),
      ],
      links: [],
    };
    expect(words(live, next)).toBe(
      'The file adds New; removes Gone; changes Lead (its role and queue) and Worker (its settings and place); changes 1 group; changes 1 link; arranges the canvas. Apply replaces corrallm’s canvas with the file’s, as your change; Keep keeps corrallm’s, and its next save writes it over the file.',
    );
  });

  it('names five agents of a list, then how many more', () => {
    const live = canvasOf(canvas, []);
    const next = canvasOf(
      canvas,
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => agent(id, {}, i * 300)),
    );
    expect(words(live, next)).toMatch(/^The file adds A, B, C, D, E and 2 more\. /);
  });

  it('says why a file isn’t a canvas, on one line', () => {
    const summary = summarize(
      'team.corral',
      undefined,
      { document: canvasOf(canvas), rows: toRows(canvasOf(canvas)) },
      { fault: 'Not a corrallm canvas:\nnodes[0] is missing' },
    );
    expect(summary).toEqual({
      file: 'team.corral',
      from: null,
      fault: 'Not a corrallm canvas: nodes[0] is missing',
    });
  });
});

it.each(['finished', 'recovered'] as const)(
  'expires Keep when a %s save writes the same baseline hash, across a restart',
  async (how) => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    await documents.load(canvas);
    const theirs = toFile(canvasOf(canvas, [agent('tester')]));
    await writeFile(file, theirs);
    await documents.review(canvas);
    const review = reviews.open(canvas);
    if (!review) throw new Error('No review');
    await documents.keepFile(canvas, review, 'you');
    if (how === 'recovered') {
      const write = wholeFile.writeWhole;
      vi.spyOn(wholeFile, 'writeWhole').mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error('Stopped after publishing the file');
      });
      await expect(documents.save(canvas, mintTrustedPath(file))).rejects.toThrow(
        'Stopped after publishing the file',
      );
    } else await documents.save(canvas, mintTrustedPath(file));
    await restart();
    await documents.review(canvas);
    await writeFile(file, theirs);
    await documents.review(canvas);
    expect(reviews.open(canvas)?.id).toBeDefined();
    expect(reviews.open(canvas)?.id).not.toBe(review.id);
  },
);

it.each(['apply', 'discard'] as const)(
  'clears an abandoned Save As writing hash when %s establishes a baseline',
  async (how) => {
    const canvas = newCanvasId();
    const original = canvasOf(canvas);
    const file = await filed(original);
    await documents.load(canvas);
    await writeFile(file, toFile(canvasOf(canvas, [agent('tester')])));
    await documents.review(canvas);
    const review = reviews.open(canvas);
    if (!review) throw new Error('No review');
    vi.spyOn(wholeFile, 'writeWhole').mockRejectedValueOnce(new Error('Save As failed'));
    await expect(
      documents.save(canvas, mintTrustedPath(path.join(profile, 'failed.corral'))),
    ).rejects.toThrow('Save As failed');
    if (how === 'apply')
      await documents.applyFile(canvas, review, 'you', {
        signal: new AbortController().signal,
        noReturn: () => undefined,
      });
    else await documents.revert(canvas, { op: 'canvas.close', by: 'you' });
    expect(
      disk.prepare('SELECT writing_hash FROM document WHERE canvas_id = ?').get(canvas),
    ).toEqual({ writing_hash: null });
    // The old attempted save is an external edit now, never recovery of that abandoned save.
    await writeFile(file, toFile(original));
    await documents.review(canvas);
    expect(reviews.open(canvas)).toBeDefined();
  },
);

describe('its writes', () => {
  const SUMMARY = { file: 'team.corral', from: null, groups: 1 };
  const OTHER = newCanvasId();

  async function loaded(): Promise<CanvasId> {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    await documents.load(canvas);
    return canvas;
  }

  async function written(within: () => Told): Promise<void> {
    const publish = await store.write(within);
    publish();
  }

  it('reads open reviews from memory, including an empty canvas, after recovery', async () => {
    const canvas = await loaded();
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), SUMMARY));
    await restart();
    const reads = vi.spyOn(store, 'prepare');
    for (let i = 0; i < 10; i++) {
      expect(reviews.open(canvas)?.summary).toEqual(SUMMARY);
      expect(reviews.items(canvas)).toHaveLength(1);
      expect(reviews.items(OTHER)).toEqual([]);
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it('keeps an unreadable timestamp from hiding another canvas’s review', async () => {
    const one = await loaded();
    const two = await loaded();
    await store.write(() => {
      reviews.raiseWithin(one, 'f'.repeat(64), SUMMARY);
      reviews.raiseWithin(two, 'a'.repeat(64), SUMMARY);
      store.run('UPDATE file_review SET raised_at = 9007199254740993 WHERE canvas_id = ?', one);
    });
    await restart();
    expect(reviews.open(one)).toBeUndefined();
    expect(reviews.open(two)?.summary).toEqual(SUMMARY);
  });

  it('keeps the serialized review when its caller later changes the summary', async () => {
    const canvas = await loaded();
    const summary = { ...SUMMARY };
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), summary));
    summary.groups = 8;
    expect(reviews.open(canvas)?.summary).toEqual(SUMMARY);
    await restart();
    expect(reviews.open(canvas)?.summary).toEqual(SUMMARY);
  });

  it('restores open reviews on rollback and removes them with their canvas', async () => {
    const canvas = await loaded();
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), SUMMARY));
    const review = reviews.open(canvas);
    if (review === undefined) throw new Error('No review.');
    for (const change of [
      () => reviews.raiseWithin(canvas, 'a'.repeat(64), { ...SUMMARY, groups: 2 }),
      () => reviews.settleWithin(review, 'kept', 'you'),
    ]) {
      await expect(
        store.write(() => {
          change();
          throw new Error('Not committed.');
        }),
      ).rejects.toThrow('Not committed.');
      expect(reviews.open(canvas)).toEqual(review);
    }
    const unsubscribe = memory.whenForgotten(() => {
      throw new Error('Not forgotten.');
    });
    try {
      await expect(memory.forget(canvas)).rejects.toThrow('Not forgotten.');
    } finally {
      unsubscribe();
    }
    expect(reviews.open(canvas)).toEqual(review);
    await memory.forget(canvas);
    expect(reviews.items(canvas)).toEqual([]);
    await restart();
    expect(reviews.items(canvas)).toEqual([]);
  });

  it('settle a review in a planned write, failing only the write that settles it again', async () => {
    const canvas = await loaded();
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), SUMMARY));
    const review = reviews.open(canvas);
    if (review === undefined) throw new Error('No review.');
    await written(() => reviews.settleWithin(review, 'kept', 'you'));
    const [again, neighbour] = await Promise.allSettled([
      store.write(() => {
        reviews.settleWithin(review, 'applied', 'you');
      }),
      store.write(() => {
        memory.ensure(OTHER);
      }),
    ]);
    expect(again).toMatchObject({
      status: 'rejected',
      reason: { message: `${review.id} was settled already.` },
    });
    expect(neighbour.status).toBe('fulfilled');
    expect(reviewRows(canvas)).toEqual([expect.objectContaining({ outcome: 'kept' })]);
  });

  it('tell of a supersede only when a review was open', async () => {
    const canvas = await loaded();
    let none: (() => void) | undefined;
    await store.write(() => {
      none = reviews.supersedeWithin(canvas);
    });
    none?.();
    expect(told).toEqual([]);
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), SUMMARY));
    told = [];
    let some: (() => void) | undefined;
    await store.write(() => {
      some = reviews.supersedeWithin(canvas);
    });
    expect(told).toEqual([]);
    some?.();
    expect(told).toEqual([[canvas, 'corrallm']]);
    expect(reviews.open(canvas)).toBeUndefined();
  });

  it('keeps the latest acknowledged publication when callbacks arrive late or a canvas was forgotten', async () => {
    const canvas = await loaded();
    await written(() => reviews.raiseWithin(canvas, 'f'.repeat(64), SUMMARY));
    const older = await store.write(() => reviews.raiseWithin(canvas, 'a'.repeat(64), SUMMARY));
    expect(reviews.open(canvas)?.hash).toBe('f'.repeat(64));
    const newer = await store.write(() => reviews.raiseWithin(canvas, 'b'.repeat(64), SUMMARY));
    newer();
    older();
    newer();
    expect(reviews.open(canvas)?.hash).toBe('b'.repeat(64));
    expect(told).toEqual([
      [canvas, 'corrallm'],
      [canvas, 'corrallm'],
    ]);
    const forgotten = await store.write(() => reviews.raiseWithin(canvas, 'c'.repeat(64), SUMMARY));
    await memory.forget(canvas);
    forgotten();
    expect(reviews.items(canvas)).toEqual([]);
  });
});
