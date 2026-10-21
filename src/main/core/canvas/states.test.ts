import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { itemKey, linkKey, META, nodeKey } from '../../../shared/model/rows';
import type { ItemRow } from '../../../shared/model/rows';
import type { Entities, MetaEntity } from '../../../shared/model/state';
import { canvasStateOf } from '../../../shared/model/state';
import { CanvasMemory } from '../../memory';
import { RunJournal } from '../../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { mintTrustedPath } from '../host';
import type { Connection } from '../store/sqlite';
import type { Store } from '../store/store';
import { onDisk, openTestStore } from '../store/test-store';
import { Documents } from './documents';
import type { Revision } from './documents';
import { CanvasStates, EDITED_EVERY } from './states';
import type { CanvasChange } from './states';

/*
 * What the core says of each canvas (B9 Design §7): a canvas's entities, changed by each commit's
 * diff at its revision, its meta (`edited` recomputed at most every EDITED_EVERY ms, a change to
 * the meta alone taking the next revision in memory), and the list of canvases it keeps.
 */

let profile: string;
let store: Store;
let memory: CanvasMemory;
let documents: Documents;
let states: CanvasStates;
let disk: Connection;
/** The clock CanvasStates reads. */
let clock: number;
/** The windows showing each canvas. */
const shown = new Map<CanvasId, number[]>();
/** What CanvasStates said of each canvas, in order, and how often the list may have changed. */
let said: { canvas: CanvasId; change: CanvasChange }[];
let listed: number;

/** A canvas: a lead and a worker, linked, the worker with a queue of two messages. */
function canvasOf(id: CanvasId): CanvasDocument {
  return {
    id,
    arrange: false,
    nodes: [
      { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
      {
        id: 'worker',
        type: 'agent',
        position: { x: 300, y: 0 },
        data: {
          label: 'Worker',
          queue: [
            { id: 'one', message: 'One' },
            { id: 'two', message: 'Two' },
          ],
        },
      },
    ],
    links: [{ source: 'lead', target: 'worker' }],
  };
}
function renamed(document: CanvasDocument, id: string, label: string): CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, label } } : node,
    ),
  };
}
async function commit(
  canvas: CanvasId,
  build: (document: CanvasDocument) => CanvasDocument,
  revision: Revision = { op: 'canvas.rename', by: 'you' },
): Promise<number | undefined> {
  const { committed } = await documents.change(canvas, {
    revision,
    build: (document) => ({ next: build(document), result: undefined }),
    check: () => undefined,
    committing: () => undefined,
  });
  return committed?.rev;
}
/** A canvas kept in a file of its own. */
async function filed(document: CanvasDocument): Promise<string> {
  const file = path.join(profile, `${document.id}.corral`);
  await writeFile(file, toFile(document));
  await memory.setFile(document.id, mintTrustedPath(file));
  return file;
}
function start(): void {
  documents = new Documents({ store, memory, catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER });
  states = new CanvasStates({
    documents,
    memory,
    store,
    shownIn: (canvas) => shown.get(canvas) ?? [],
    running: () => [],
    now: () => clock,
  });
  said = [];
  listed = 0;
  states.listen({
    canvas: (canvas, change) => said.push({ canvas, change }),
    list: () => (listed += 1),
  });
}
/** The changes said of `canvas` since the last time asked. */
function heard(canvas: CanvasId): CanvasChange[] {
  const changes = said.filter((one) => one.canvas === canvas).map(({ change }) => change);
  said = said.filter((one) => one.canvas !== canvas);
  return changes;
}
/** `entities` as a window keeps them once it applied `changes`. */
function applied(entities: Entities, changes: readonly CanvasChange[]): Entities {
  let next: Record<string, Entities[string]> = { ...entities };
  for (const { set, remove = [] } of changes) {
    next = { ...next, ...set };
    for (const key of remove) Reflect.deleteProperty(next, key);
  }
  return next;
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-states-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  disk = onDisk(profile);
  clock = 1_000_000;
  shown.clear();
  start();
});
afterEach(async () => {
  states.close();
  disk.close();
  await memory.flush();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

describe('a canvas’s entities', () => {
  it('are its document’s rows, each stamped, and its meta, which canvasStateOf reads back', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const { rev, entities, document } = await states.read(canvas);
    expect(rev).toBe(1);
    expect(entities[nodeKey('worker')]).toMatchObject({ label: 'Worker', rev: 1, by: 'you' });
    expect(entities[META]).toEqual({
      arrange: false,
      name: `${canvas}.corral`,
      edited: false,
      project: null,
      rev: 0,
      by: 'corrallm',
    });
    const state = canvasStateOf(canvas, rev, entities);
    expect({ id: canvas, arrange: state.arrange, nodes: state.nodes, links: state.links }).toEqual(
      document,
    );
    expect(state.entities[itemKey('worker', 'two')]).toEqual({ rev: 1, by: 'you' });
  });

  it('change by each commit’s diff alone, at its revision, stamped with its party', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const before = await states.read(canvas);
    expect(heard(canvas)).toEqual([]);

    const rev = await commit(canvas, (document) => renamed(document, 'worker', 'Builder'), {
      op: 'canvas.rename',
      by: 'outside:orchestrator',
    });
    expect(rev).toBe(2);
    const [renaming, ...more] = heard(canvas);
    expect(more).toEqual([]);
    expect(renaming).toEqual({
      rev: 2,
      by: 'outside:orchestrator',
      set: {
        [nodeKey('worker')]: expect.objectContaining({
          label: 'Builder',
          rev: 2,
          by: 'outside:orchestrator',
        }) as unknown,
        // Edited now, said with the commit that made it so.
        [META]: expect.objectContaining({
          edited: true,
          rev: 2,
          by: 'outside:orchestrator',
        }) as unknown,
      },
    });

    await commit(canvas, (document) => ({ ...document, links: [] }));
    const [unlinking] = heard(canvas);
    expect(unlinking).toEqual({ rev: 3, by: 'you', set: {}, remove: [linkKey('lead', 'worker')] });

    // A window's copy, applying them, is the entities as they are now; unchanged ones are the very
    // same objects.
    const now = states.now(canvas);
    if (renaming === undefined || unlinking === undefined) throw new Error('Nothing was said.');
    expect(applied(before.entities, [renaming, unlinking])).toEqual(now.entities);
    expect(now.entities[nodeKey('lead')]).toBe(before.entities[nodeKey('lead')]);
  });

  it('carry a row whose place alone was numbered anew, keeping its revision', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    await documents.load(canvas);
    // Its queue's places as close as numbers come: nothing lies between them.
    await memory.flush();
    await store.write(() => {
      store
        .prepare(`UPDATE queue_item SET place = ? WHERE canvas_id = ? AND id = 'two'`)
        .run(1 + Number.EPSILON, canvas);
      store
        .prepare(`UPDATE queue_item SET place = 1 WHERE canvas_id = ? AND id = 'one'`)
        .run(canvas);
    });
    start();
    await states.read(canvas);
    await commit(canvas, (document) => ({
      ...document,
      nodes: document.nodes.map((node) =>
        node.type === 'agent' && node.id === 'worker'
          ? {
              ...node,
              data: {
                ...node.data,
                queue: [
                  { id: 'one', message: 'One' },
                  { id: 'between', message: 'Between' },
                  { id: 'two', message: 'Two' },
                ],
              },
            }
          : node,
      ),
    }));
    const [change] = heard(canvas);
    const set = change?.set ?? {};
    expect(Object.keys(set).sort()).toEqual(
      [
        META,
        itemKey('worker', 'between'),
        itemKey('worker', 'one'),
        itemKey('worker', 'two'),
      ].sort(),
    );
    // Numbered anew, its entity unchanged: its revision is the one it had.
    expect(set[itemKey('worker', 'two')]).toMatchObject({ place: 2, rev: 1 });
    expect(set[itemKey('worker', 'between')]).toMatchObject({ place: 1, rev: 2 });
    expect((set[itemKey('worker', 'one')] as ItemRow).place).toBe(0);
  });
});

describe('a canvas’s meta', () => {
  it('recomputes edited at most every EDITED_EVERY ms, the meta alone taking the next revision in memory', async () => {
    const canvas = newCanvasId();
    const original = canvasOf(canvas);
    await filed(original);
    await states.read(canvas);

    // The first commit: edited at once, with it.
    await commit(canvas, (document) => renamed(document, 'worker', 'Builder'));
    expect(
      heard(canvas).map(({ rev, set }) => [rev, (set[META] as MetaEntity | undefined)?.edited]),
    ).toEqual([[2, true]]);

    // One soon after, undoing it: as it was saved, but not said so until EDITED_EVERY has passed.
    clock += EDITED_EVERY / 5;
    await commit(canvas, () => original);
    expect(heard(canvas).map(({ rev, set }) => [rev, set[META]])).toEqual([[3, undefined]]);
    clock += EDITED_EVERY;
    await vi.waitFor(() => {
      expect(said).toHaveLength(1);
    });
    expect(heard(canvas)).toEqual([
      {
        rev: 4,
        by: 'corrallm',
        set: {
          [META]: expect.objectContaining({ edited: false, rev: 4, by: 'corrallm' }) as unknown,
        },
      },
    ]);
    expect(states.now(canvas).rev).toBe(4);
    // In memory only: what is on disk is the last commit's revision.
    expect(disk.prepare('SELECT rev FROM document WHERE canvas_id = ?').get(canvas)).toEqual({
      rev: 3,
    });
    // The next commit takes the one after.
    clock += EDITED_EVERY;
    await expect(commit(canvas, (document) => renamed(document, 'lead', 'Boss'))).resolves.toBe(5);
    expect(heard(canvas).map(({ rev }) => rev)).toEqual([5]);
  });

  it('says a folder chosen, and a save, as changes to the meta alone', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    await states.read(canvas);
    await commit(canvas, (document) => renamed(document, 'worker', 'Builder'));
    heard(canvas);

    const folder = path.join(profile, 'project');
    await memory.update(canvas, (remembered) => ({
      ...remembered,
      project: mintTrustedPath(folder),
    }));
    await states.refresh(canvas);
    expect(heard(canvas)).toEqual([
      {
        rev: 3,
        by: 'corrallm',
        set: {
          [META]: expect.objectContaining({
            project: { name: 'project', path: folder },
            edited: true,
          }) as unknown,
        },
      },
    ]);

    await documents.save(canvas, mintTrustedPath(file));
    await states.refresh(canvas);
    expect(heard(canvas)).toEqual([
      {
        rev: 4,
        by: 'corrallm',
        set: { [META]: expect.objectContaining({ edited: false, rev: 4 }) as unknown },
      },
    ]);
    // Said again, nothing changed: nothing is said.
    await states.refresh(canvas);
    expect(heard(canvas)).toEqual([]);
  });
});

describe('the list of canvases', () => {
  it('holds every canvas worth listing, the one used most recently first', async () => {
    const saved = newCanvasId();
    await filed(canvasOf(saved));
    // A draft that holds something, never saved: edited.
    const draft = newCanvasId();
    await documents.load(draft);
    await commit(draft, () => canvasOf(draft));
    // A draft shown in a window, and one neither shown nor holding anything.
    const empty = newCanvasId();
    const hidden = newCanvasId();
    const journal = new RunJournal({ store, memory });
    await journal.opened(empty);
    await memory.update(hidden, (remembered) => remembered);
    await store.write(() => {
      store.prepare('DELETE FROM open_canvas').run();
    });
    shown.set(empty, [7]);
    // The saved one's run, running as last journaled.
    await store.write(() => {
      store
        .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, ?)')
        .run(
          saved,
          JSON.stringify({ version: 2, state: { version: 2, run: { running: true } } }),
          1,
        );
    });

    // A canvas never followed is read for whether it is edited; a draft that holds nothing isn't.
    start();
    expect(await states.list()).toEqual([
      {
        canvas: empty,
        name: null,
        edited: false,
        running: false,
        open: true,
        project: null,
        shownIn: [7],
      },
      {
        canvas: draft,
        name: null,
        edited: true,
        running: false,
        open: false,
        project: null,
        shownIn: [],
      },
      {
        canvas: saved,
        name: `${saved}.corral`,
        edited: false,
        running: true,
        open: false,
        project: null,
        shownIn: [],
      },
    ]);
    expect(states.keeps(hidden)).toBe(true);
    await expect(states.read(newCanvasId())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('may have changed as a canvas followed is edited, or kept, and with each commit of one that isn’t', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    await states.read(canvas);
    listed = 0;
    await commit(canvas, (document) => renamed(document, 'worker', 'Builder'));
    expect(listed).toBe(1);
    // Still edited: the list is as it was.
    clock += EDITED_EVERY;
    await commit(canvas, (document) => renamed(document, 'worker', 'Maker'));
    expect(listed).toBe(1);

    // A draft followed (one a window began), holding something now: kept.
    const draft = newCanvasId();
    await documents.load(draft);
    await states.read(draft);
    listed = 0;
    await commit(draft, () => canvasOf(draft));
    expect(listed).toBe(1);

    // One not followed: whatever it is now, the list reads it again.
    const other = newCanvasId();
    await filed(canvasOf(other));
    await documents.load(other);
    listed = 0;
    await commit(other, (document) => renamed(document, 'lead', 'Boss'));
    expect(listed).toBe(1);
  });
});
