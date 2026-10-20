import { writeFileSync } from 'node:fs';
import * as wholeFile from '../../whole-file';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { CanvasMemory } from '../../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { mintTrustedPath } from '../host';
import type { Connection } from '../store/sqlite';
import { SYSTEM_DEPS } from '../store/store';
import type { Store, StoreDeps } from '../store/store';
import { onDisk, openTestStore, refuseWrites } from '../store/test-store';
import { CommitFailed, Documents } from './documents';
import type { Revision } from './documents';

/*
 * A canvas's document in the core (B9 Design §2, §5): read once from its rows, or from its file
 * when it has none, kept in memory, committed by what changed, and saved by the core itself.
 */

let profile: string;
let store: Store;
let memory: CanvasMemory;
let documents: Documents;
/** What is on disk, read through a connection of its own. */
let disk: Connection;

const REQUEST = '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b01';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A canvas: a group of a lead and a worker, linked, the worker with a queue. */
function canvasOf(id: CanvasId): CanvasDocument {
  return {
    id,
    arrange: false,
    nodes: [
      { id: 'team', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team' } },
      {
        id: 'lead',
        type: 'agent',
        parentId: 'team',
        position: { x: 20, y: 52 },
        data: { label: 'Lead', role: 'Lead the team.' },
      },
      {
        id: 'worker',
        type: 'agent',
        parentId: 'team',
        position: { x: 260, y: 52 },
        data: {
          label: 'Worker',
          adapter: 'codex',
          queue: [
            { id: 'hello', message: 'Say hello' },
            {
              id: 'loop',
              repeat: [{ id: 'test', action: 'exec_command', instruction: 'npm test' }],
              until: { kind: 'succeeded' },
              rounds: 3,
              otherwise: 'ask',
            },
          ],
        },
      },
    ],
    links: [{ source: 'lead', target: 'worker' }],
  };
}
/** `document` with its agent `id`'s label `label`. */
function renamed(document: CanvasDocument, id: string, label: string): CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, label } } : node,
    ),
  };
}

/**
 * Commits `next` as the canvas's document, as an op building it would: its revision, or none if it
 * changed nothing.
 */
async function commit(
  canvas: CanvasId,
  next: CanvasDocument,
  revision: Revision = { op: 'canvas.rename', by: 'you' },
): Promise<number | undefined> {
  const { committed } = await documents.change(canvas, {
    revision,
    build: () => ({ next, result: undefined }),
    check: () => undefined,
    committing: () => undefined,
  });
  return committed?.rev;
}

function documentsOf(database: Store = store): Documents {
  return new Documents({
    store: database,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
}
/** Closes the store and opens it again, as the core does when it starts again. */
async function restart(deps?: StoreDeps): Promise<void> {
  await memory.flush();
  await store.close();
  store = await openTestStore(profile, deps);
  memory = new CanvasMemory(store);
  documents = documentsOf();
}
/** A canvas kept in a file of its own, `bytes` its file's (its text as toFile writes it). */
async function filed(document: CanvasDocument, bytes = toFile(document)): Promise<string> {
  const file = path.join(profile, `${document.id}.corral`);
  await writeFile(file, bytes);
  await memory.setFile(document.id, mintTrustedPath(file));
  return file;
}
const documentRow = (canvas: CanvasId) =>
  disk
    .prepare(
      `SELECT rev, arrange, saved_hash, file_hash, writing_hash, by_party FROM document
       WHERE canvas_id = ?`,
    )
    .get(canvas);
const count = (table: string, canvas: CanvasId) =>
  disk.prepare(`SELECT count(*) AS n FROM ${table} WHERE canvas_id = ?`).get(canvas)?.n;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-documents-'));
  store = await openTestStore(profile);
  memory = new CanvasMemory(store);
  documents = documentsOf();
  disk = onDisk(profile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  disk.close();
  await memory.flush();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

describe('a canvas’s document', () => {
  it('is read from its file once it has none, then kept in rows under the canvas’s id', async () => {
    const canvas = newCanvasId();
    const document = canvasOf(canvas);
    // Its file as another program wrote it: what it means, in other bytes.
    const bytes = `${JSON.stringify(JSON.parse(toFile(document)))}\n`;
    const file = await filed(document, bytes);

    const live = await documents.load(canvas);

    expect(live.document).toEqual(document);
    expect(live.rev).toBe(1);
    expect(documents.edited(canvas)).toBe(false);
    expect(documentRow(canvas)).toEqual({
      rev: 1,
      arrange: 0,
      saved_hash: sha256(toFile(document)),
      file_hash: sha256(bytes),
      writing_hash: null,
      by_party: 'you',
    });
    expect(
      disk.prepare('SELECT rev, op, by_party FROM revision WHERE canvas_id = ?').all(canvas),
    ).toEqual([{ rev: 1, op: 'file.open', by_party: 'you' }]);
    expect([count('node', canvas), count('link', canvas), count('queue_item', canvas)]).toEqual([
      3, 1, 3,
    ]);

    // Its rows are what it is now: a file changed since is not read again.
    await writeFile(file, toFile(renamed(document, 'lead', 'Changed on disk')));
    await restart();
    expect((await documents.load(canvas)).document).toEqual(document);
  });

  it('is read under the id it opens as: a copy’s own, not the one its file holds', async () => {
    const original = canvasOf(newCanvasId());
    const copy = newCanvasId();
    const live = await documents.open(copy, toFile(original));
    expect(live.document).toEqual({ ...original, id: copy });
    expect(await documents.textOf(copy)).toBe(toFile({ ...original, id: copy }));
  });

  it('commits what changed alone, each entity it changed at the next revision, and what it was', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const before = await documents.load(canvas);
    const next = renamed(before.document, 'worker', 'Builder');

    await expect(
      commit(canvas, next, { op: 'canvas.rename', by: 'outside:orchestrator' }),
    ).resolves.toBe(2);

    expect(documents.live(canvas)).toMatchObject({ document: next, rev: 2 });
    expect(
      disk
        .prepare('SELECT id, label, rev, by_party FROM node WHERE canvas_id = ? ORDER BY place')
        .all(canvas),
    ).toEqual([
      { id: 'team', label: 'Team', rev: 1, by_party: 'you' },
      { id: 'lead', label: 'Lead', rev: 1, by_party: 'you' },
      { id: 'worker', label: 'Builder', rev: 2, by_party: 'outside:orchestrator' },
    ]);
    expect(
      disk.prepare('SELECT max(rev) AS rev FROM queue_item WHERE canvas_id = ?').get(canvas),
    ).toEqual({ rev: 1 });
    expect(
      disk
        .prepare(
          `SELECT entity, rev_before, json_extract(before_data, '$.label') AS before,
             json_extract(after_data, '$.label') AS after
           FROM change WHERE canvas_id = ? AND rev = 2`,
        )
        .all(canvas),
    ).toEqual([{ entity: 'node/worker', rev_before: 1, before: 'Worker', after: 'Builder' }]);
    expect(documentRow(canvas)).toMatchObject({ rev: 2, by_party: 'outside:orchestrator' });
    expect(documents.live(canvas).revs.get('node/worker')).toBe(2);

    // The same document again changes nothing, and takes no revision.
    await expect(commit(canvas, next)).resolves.toBeUndefined();
    expect(count('revision', canvas)).toBe(2);
    expect(documents.live(canvas).rev).toBe(2);
  });

  it('builds an op’s change over the live document, checks it, then commits it past its point of no return', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const live = await documents.load(canvas);
    const heard: string[] = [];
    const changed = await documents.change(canvas, {
      revision: { op: 'canvas.rename', by: 'outside:orchestrator', request: REQUEST },
      build: (document) => {
        heard.push('build');
        return { next: renamed(document, 'worker', 'Builder'), result: 'renamed' };
      },
      check: (change, checked) => {
        heard.push('check');
        expect(checked).toBe(live);
        expect([...change.entities.keys()]).toEqual(['node/worker']);
        expect(change).toMatchObject({ op: 'canvas.rename', by: 'outside:orchestrator' });
      },
      committing: () => {
        heard.push(`committing at ${String(count('revision', canvas))}`);
      },
    });
    expect(heard).toEqual(['build', 'check', 'committing at 1']);
    expect(changed).toMatchObject({ result: 'renamed', committed: { rev: 2 } });
    expect(changed.committed?.change.entities.get('node/worker')).toMatchObject({
      before: { label: 'Worker' },
      after: { label: 'Builder' },
      rev: 1,
    });
    expect(
      disk
        .prepare('SELECT op, by_party, request FROM revision WHERE canvas_id = ? AND rev = 2')
        .get(canvas),
    ).toEqual({ op: 'canvas.rename', by_party: 'outside:orchestrator', request: REQUEST });
  });

  it('writes nothing a check refuses, and never says it is past its point of no return', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const before = await documents.load(canvas);
    let committing = false;
    await expect(
      documents.change(canvas, {
        revision: { op: 'canvas.rename', by: 'outside:orchestrator' },
        build: (document) => ({ next: renamed(document, 'worker', 'Builder'), result: undefined }),
        check: () => {
          throw new Error('It changed since.');
        },
        committing: () => {
          committing = true;
        },
      }),
    ).rejects.toThrow('It changed since.');
    expect(committing).toBe(false);
    expect(documents.live(canvas)).toMatchObject({ document: before.document, rev: 1 });
    expect(count('revision', canvas)).toBe(1);
  });

  it('checks and writes nothing for a build that changes nothing', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    await documents.load(canvas);
    const checked: unknown[] = [];
    const changed = await documents.change(canvas, {
      revision: { op: 'canvas.rename', by: 'you' },
      build: (document) => ({ next: renamed(document, 'worker', 'Worker'), result: 'same' }),
      check: (change) => checked.push(change),
      committing: () => checked.push('committing'),
    });
    expect(changed).toEqual({ result: 'same' });
    expect(checked).toEqual([]);
    expect(count('revision', canvas)).toBe(1);
  });

  it('refuses a change to a canvas whose document isn’t loaded, building nothing', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    let built = false;
    await expect(
      documents.change(canvas, {
        revision: { op: 'canvas.rename', by: 'you' },
        build: (document) => {
          built = true;
          return { next: document, result: undefined };
        },
        check: () => undefined,
        committing: () => undefined,
      }),
    ).rejects.toThrow('That canvas isn’t open in corrallm.');
    expect(built).toBe(false);
    expect(documentRow(canvas)).toBeUndefined();
  });

  it('restores the edits made since it was saved after a restart, as edited', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    const next = renamed((await documents.load(canvas)).document, 'lead', 'Head');
    await commit(canvas, next);
    expect(documents.edited(canvas)).toBe(true);

    await restart();
    const live = await documents.load(canvas);
    expect(live.document).toEqual(next);
    expect(live.rev).toBe(2);
    expect(documents.edited(canvas)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(toFile(canvasOf(canvas)));
  });

  it('is left as it was when its commit fails, and the next commit writes it', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const before = await documents.load(canvas);
    const next = renamed(before.document, 'worker', 'Builder');
    const allow = refuseWrites(profile, 'node', 'The disk is full');

    const failed = commit(canvas, next);
    await expect(failed).rejects.toBeInstanceOf(CommitFailed);
    await expect(failed).rejects.toThrow('The disk is full');
    expect(documents.live(canvas)).toMatchObject({ document: before.document, rev: 1 });
    expect(count('revision', canvas)).toBe(1);

    allow();
    await expect(commit(canvas, next)).resolves.toBe(2);
    await restart();
    expect((await documents.load(canvas)).document).toEqual(next);
  });

  it('is left as it was when its commit’s flush fails, every change after it refused with the database’s error until it is opened again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failing = false;
    await restart({
      ...SYSTEM_DEPS,
      flush: (fd) =>
        failing ? Promise.reject(new Error('EIO: fsync failed')) : SYSTEM_DEPS.flush(fd),
    });
    const canvas = newCanvasId();
    const other = newCanvasId();
    await filed(canvasOf(canvas));
    const file = await filed(canvasOf(other));
    const before = (await documents.load(canvas)).document;
    const untouched = (await documents.load(other)).document;
    const one = renamed(before, 'worker', 'One');
    /** The database's error, once it failed closed. */
    const FAILED =
      /The core’s database could not be written to the drive \(EIO: fsync failed\), so it keeps nothing more until the core opens it again/;

    failing = true;
    const failed = commit(canvas, one);
    await expect(failed).rejects.toBeInstanceOf(CommitFailed);
    await expect(failed).rejects.toThrow(
      /^The change couldn’t be written, so nothing changed: The core’s database could not be written to the drive/,
    );
    expect(documents.live(canvas)).toMatchObject({ document: before, rev: 1 });
    expect(documents.edited(canvas)).toBe(false);
    failing = false;

    // Its flushes work again, but the database keeps nothing more, of any canvas, until it is
    // opened again: no commit, edit or save.
    const two = renamed(untouched, 'lead', 'Two');
    await expect(commit(other, two)).rejects.toThrow(FAILED);
    await expect(commit(canvas, one)).rejects.toThrow(FAILED);
    await expect(documents.edit(other, toFile(two))).rejects.toThrow(FAILED);
    await expect(documents.save(other, mintTrustedPath(file))).rejects.toThrow(FAILED);
    expect(documents.live(canvas)).toMatchObject({ document: before, rev: 1 });
    expect(documents.live(other)).toMatchObject({ document: untouched, rev: 1 });
    expect(await readFile(file, 'utf8')).toBe(toFile(canvasOf(other)));

    // Opened again (with no other connection keeping its log's index, as in the core's process),
    // it holds neither change, and commits again.
    disk.close();
    await restart();
    disk = onDisk(profile);
    expect(await documents.load(canvas)).toMatchObject({ document: before, rev: 1 });
    expect(await documents.load(other)).toMatchObject({ document: untouched, rev: 1 });
    await expect(commit(canvas, one)).resolves.toBe(2);
    expect(documentRow(canvas)).toMatchObject({ rev: 2 });
  });

  it('refuses a change its rows can’t hold, writing nothing', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const { document } = await documents.load(canvas);
    const [team, lead, worker] = document.nodes as [CanvasNode, CanvasNode, CanvasNode];
    // The worker made a frame, its link to the lead kept.
    const framed: CanvasDocument = {
      ...document,
      nodes: [team, lead, { ...worker, type: 'frame', data: { label: 'Worker' } }],
    };
    // The lead put in a frame that comes after it.
    const crew: CanvasNode = {
      id: 'crew',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Crew' },
    };
    const misordered: CanvasDocument = {
      ...document,
      nodes: [team, { ...lead, parentId: 'crew' }, worker, crew],
    };
    for (const [next, fault] of [
      [framed, 'link/lead/worker: one of its agents isn’t there'],
      [misordered, 'node/lead: it comes before its parent'],
    ] as const) {
      await expect(commit(canvas, next)).rejects.toMatchObject({
        code: 'invalid',
        message: `That change can’t be kept: ${fault}.`,
      });
    }
    expect(documents.live(canvas)).toMatchObject({ document, rev: 1 });
    expect(count('revision', canvas)).toBe(1);
    await restart();
    expect((await documents.load(canvas)).document).toEqual(document);
  });

  it('removes what goes, items before what holds them and nodes before their parents', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const { document } = await documents.load(canvas);
    const lone: CanvasDocument = {
      ...document,
      nodes: [{ id: 'lead', type: 'agent', position: { x: 20, y: 52 }, data: { label: 'Lead' } }],
      links: [],
    };
    await commit(canvas, lone, { op: 'canvas.delete', by: 'you' });
    expect([count('node', canvas), count('link', canvas), count('queue_item', canvas)]).toEqual([
      1, 0, 0,
    ]);
    await restart();
    expect((await documents.load(canvas)).document).toEqual(lone);
  });

  it('saves its own text to its file, as the canvas’s, and is not edited once saved', async () => {
    const canvas = newCanvasId();
    await documents.edit(canvas, toFile(canvasOf(canvas)));
    expect(documents.edited(canvas)).toBe(true);
    const file = mintTrustedPath(path.join(profile, 'team.corral'));

    await documents.save(canvas, file);

    const text = toFile(documents.live(canvas).document);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect((await memory.get(canvas)).file).toBe(file);
    expect(documentRow(canvas)).toMatchObject({
      saved_hash: sha256(text),
      file_hash: sha256(text),
      writing_hash: null,
    });
    expect(documents.edited(canvas)).toBe(false);
    const next = renamed(documents.live(canvas).document, 'lead', 'Head');
    await commit(canvas, next);
    expect(documents.edited(canvas)).toBe(true);
    await commit(canvas, canvasOf(canvas));
    expect(documents.edited(canvas)).toBe(false);
  });

  it('takes a save cut short once its text reached the file as saved, and one cut short before as not', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    const next = renamed((await documents.load(canvas)).document, 'lead', 'Head');
    await commit(canvas, next);
    const before = documentRow(canvas);
    // As a save leaves it when the core stops after the file was written, before its last commit.
    const saving = async (written: boolean) => {
      await restart();
      store
        .prepare('UPDATE document SET writing_hash = ? WHERE canvas_id = ?')
        .run(sha256(toFile(next)), canvas);
      await writeFile(file, written ? toFile(next) : toFile(canvasOf(canvas)));
      await restart();
      await documents.load(canvas);
    };

    await saving(false);
    expect(documentRow(canvas)).toEqual(before);
    expect(documents.edited(canvas)).toBe(true);

    await saving(true);
    expect(documentRow(canvas)).toMatchObject({
      saved_hash: sha256(toFile(next)),
      file_hash: sha256(toFile(next)),
      writing_hash: null,
    });
    expect(documents.edited(canvas)).toBe(false);
  });

  it('is written whole again once canvas memory forgot its canvas while it was loaded', async () => {
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    const { document } = await documents.load(canvas);
    // Forgotten as canvas memory forgets the canvases used least recently, with all of it.
    store.prepare('DELETE FROM canvas WHERE id = ?').run(canvas);
    await commit(canvas, renamed(document, 'lead', 'Head'));
    await restart();
    expect((await documents.load(canvas)).document).toEqual(renamed(document, 'lead', 'Head'));

    store.prepare('DELETE FROM canvas WHERE id = ?').run(canvas);
    await documents.save(canvas, mintTrustedPath(file));
    await restart();
    expect((await documents.load(canvas)).document).toEqual(renamed(document, 'lead', 'Head'));
    expect(documents.edited(canvas)).toBe(false);
  });

  it('keeps nothing of a draft until it holds something', async () => {
    const draft = newCanvasId();
    expect((await documents.load(draft)).document).toEqual({
      id: draft,
      arrange: false,
      nodes: [],
      links: [],
    });
    await expect(documents.textOf(draft)).resolves.toBeUndefined();
    await documents.edit(draft, toFile({ id: draft, arrange: false, nodes: [], links: [] }));
    expect(documentRow(draft)).toBeUndefined();

    await documents.edit(draft, toFile(canvasOf(draft)));
    expect(documentRow(draft)).toMatchObject({ rev: 1, saved_hash: null, file_hash: null });
    await restart();
    await expect(documents.textOf(draft)).resolves.toBe(toFile(canvasOf(draft)));
  });

  it('refuses text that isn’t a canvas, or is another canvas’s, changing nothing', async () => {
    const canvas = newCanvasId();
    await documents.edit(canvas, toFile(canvasOf(canvas)));
    await expect(documents.edit(canvas, 'Remember the milk')).rejects.toThrow(
      'This is not a corrallm canvas',
    );
    await expect(documents.edit(canvas, toFile(canvasOf(newCanvasId())))).rejects.toThrow(
      'This canvas’s text is another canvas’s.',
    );
    expect(documents.live(canvas)).toMatchObject({ document: canvasOf(canvas), rev: 1 });
  });

  it('commits one at a time on a canvas, each against what the one before left', async () => {
    const canvas = newCanvasId();
    await documents.edit(canvas, toFile(canvasOf(canvas)));
    const first = renamed(canvasOf(canvas), 'lead', 'One');
    const second = renamed(first, 'worker', 'Two');
    // The second is built over what the first left.
    const built: string[] = [];
    const rename = (id: string, label: string) =>
      documents.change(canvas, {
        revision: { op: 'canvas.rename', by: 'you' },
        build: (document) => {
          built.push(document.nodes.map((node) => node.data.label).join(', '));
          return { next: renamed(document, id, label), result: label };
        },
        check: () => undefined,
        committing: () => undefined,
      });
    const changes = await Promise.all([rename('lead', 'One'), rename('worker', 'Two')]);
    expect(changes.map(({ result, committed }) => [result, committed?.rev])).toEqual([
      ['One', 2],
      ['Two', 3],
    ]);
    expect(built).toEqual(['Team, Lead, Worker', 'Team, One, Worker']);
    expect(documents.live(canvas).document).toEqual(second);
    expect(
      disk
        .prepare('SELECT rev, entity FROM change WHERE canvas_id = ? AND rev > 1 ORDER BY rev')
        .all(canvas),
    ).toEqual([
      { rev: 2, entity: 'node/lead' },
      { rev: 3, entity: 'node/worker' },
    ]);
  });

  it('keeps the last thousand revisions, trimmed every hundred commits with what each changed', async () => {
    // Its log's flushes skipped: a thousand commits, quickly.
    await restart({ ...SYSTEM_DEPS, flush: () => Promise.resolve() });
    const canvas = newCanvasId();
    await documents.load(canvas);
    for (let i = 1; i <= 1101; i++) {
      await commit(canvas, renamed(canvasOf(canvas), 'lead', `Lead ${String(i)}`));
    }
    expect(
      disk
        .prepare('SELECT count(*) AS n, min(rev) AS first FROM revision WHERE canvas_id = ?')
        .get(canvas),
    ).toEqual({ n: 1001, first: 101 });
    expect(
      disk.prepare('SELECT min(rev) AS first FROM change WHERE canvas_id = ?').get(canvas),
    ).toEqual({ first: 101 });
  });

  it('fails alone a write whose reference is to nothing, while what shares its commit lands', async () => {
    const canvas = newCanvasId();
    await documents.edit(canvas, toFile(canvasOf(canvas)));
    const [refused, sent] = await Promise.allSettled([
      store.write(() =>
        store
          .prepare(
            `INSERT INTO queue_item (canvas_id, agent_id, id, place, kind, body, rev, by_party)
             VALUES (?, 'nobody', 'x', 0, 'message', '{}', 2, 'you')`,
          )
          .run(canvas),
      ),
      store.write(() =>
        store
          .prepare(
            `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, state, sent_at)
             VALUES ('m', ?, 'you', 'agent:lead', 'text', 'Hello', 'pending', 1)`,
          )
          .run(canvas),
      ),
    ]);
    expect(refused).toMatchObject({ status: 'rejected' });
    expect(String((refused as PromiseRejectedResult).reason)).toMatch(/FOREIGN KEY/);
    expect(sent).toMatchObject({ status: 'fulfilled' });
    expect(count('message', canvas)).toBe(1);
  });
  it('a failed Save As path update rolls back its hashes and rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = newCanvasId();
    const file = await filed(canvasOf(canvas));
    await documents.load(canvas);
    const saved = documentRow(canvas);
    await commit(canvas, renamed(documents.live(canvas).document, 'lead', 'Changed'));
    const next = mintTrustedPath(path.join(profile, 'new.corral'));
    store.exec(
      "CREATE TEMP TRIGGER fail_file_memory BEFORE UPDATE OF file ON canvas BEGIN SELECT RAISE(ABORT, 'disk full writing canvas file'); END",
    );
    try {
      const result = await documents.save(canvas, next).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      const freshMemory = new CanvasMemory(store);
      expect((await freshMemory.get(canvas)).file).toBe(file);
      expect(documentRow(canvas)).toMatchObject({
        saved_hash: saved?.saved_hash,
        file_hash: saved?.file_hash,
        writing_hash: sha256(toFile(documents.live(canvas).document)),
      });
      const fresh = new Documents({
        store,
        memory: freshMemory,
        catalog: CATALOG,
        defaultAdapter: DEFAULT_ADAPTER,
      });
      await fresh.load(canvas);
      expect(fresh.edited(canvas)).toBe(true);
    } finally {
      store.exec('DROP TRIGGER fail_file_memory');
      await memory.setFile(canvas, mintTrustedPath(file));
    }
  });

  it('serializes saves across canvases so a file’s last writer is its remembered owner', async () => {
    await restart({ ...SYSTEM_DEPS, flush: () => Promise.resolve() });
    const first = newCanvasId();
    const second = newCanvasId();
    await documents.edit(first, toFile(canvasOf(first)));
    await documents.edit(second, toFile(canvasOf(second)));
    const file = mintTrustedPath(path.join(profile, 'shared.corral'));
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const starts: string[] = [];
    vi.spyOn(wholeFile, 'writeWhole').mockImplementation(async (file, text) => {
      const id = (JSON.parse(text) as { id: string }).id;
      starts.push(id);
      writeFileSync(file, text);
      if (id === first) {
        entered.resolve(undefined);
        await release.promise;
      }
    });
    const one = documents.save(first, file);
    await entered.promise;
    const two = documents.save(second, file);
    try {
      // With flushes resolved immediately, two turns let an unguarded second save enter its writer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts).toEqual([first]);
    } finally {
      release.resolve(undefined);
      await Promise.all([one, two]);
    }
    expect((JSON.parse(await readFile(file, 'utf8')) as { id: string }).id).toBe(second);
    expect(await memory.canvasWithFile(file)).toBe(second);
    expect(documentRow(second)?.file_hash).toBe(sha256(await readFile(file, 'utf8')));
  });
});

describe('the agents a party created', () => {
  /** `document` with a new agent `id`. */
  const withAgent = (document: CanvasDocument, id: string): CanvasDocument => ({
    ...document,
    nodes: [
      ...document.nodes,
      { id, type: 'agent', position: { x: 900, y: 0 }, data: { label: id } },
    ],
  });
  const creators = (canvas: CanvasId) =>
    disk
      .prepare(`SELECT id, created_by FROM node WHERE canvas_id = ? AND kind = 'agent' ORDER BY id`)
      .all(canvas);
  const ORCHESTRATOR = 'outside:orchestrator' as const;

  it('keeps who created each agent: the party whose change made it one, none read from a file, after a restart too', async () => {
    const canvas = newCanvasId();
    await filed(canvasOf(canvas));
    const { document } = await documents.load(canvas);
    await commit(canvas, withAgent(document, 'scout'), { op: 'canvas.addAgent', by: ORCHESTRATOR });
    // A frame made an agent, by whoever made it one.
    const team = documents.live(canvas).document;
    await commit(
      canvas,
      {
        ...team,
        nodes: team.nodes.map((node) =>
          node.id === 'team' ? { ...node, type: 'agent', data: { label: 'Team' } } : node,
        ),
      },
      { op: 'canvas.addParent', by: 'agent:lead' },
    );
    const kept = [
      { id: 'lead', created_by: null },
      { id: 'scout', created_by: ORCHESTRATOR },
      { id: 'team', created_by: 'agent:lead' },
      { id: 'worker', created_by: null },
    ];
    expect(creators(canvas)).toEqual(kept);
    // Forgotten with its canvas while it was loaded, written whole again: with who created each.
    store.prepare('DELETE FROM canvas WHERE id = ?').run(canvas);
    await commit(canvas, renamed(documents.live(canvas).document, 'lead', 'Head'));
    await restart();
    await documents.load(canvas);
    await commit(canvas, renamed(documents.live(canvas).document, 'scout', 'Scout'));
    expect(creators(canvas)).toEqual(kept);
  });

  it('counts a party’s live agents on every canvas, or on one, from when a change passed its checks', async () => {
    const [one, two] = [newCanvasId(), newCanvasId()];
    for (const canvas of [one, two]) await documents.edit(canvas, toFile(canvasOf(canvas)));
    await commit(one, withAgent(documents.live(one).document, 'first'), {
      op: 'canvas.addAgent',
      by: ORCHESTRATOR,
    });
    // On its way to disk, it counts already: another canvas's change checked meanwhile sees it.
    const counted: number[] = [];
    await documents.change(two, {
      revision: { op: 'canvas.addAgent', by: ORCHESTRATOR },
      build: (document) => ({ next: withAgent(document, 'second'), result: undefined }),
      check: () => undefined,
      committing: () => {
        counted.push(documents.created(ORCHESTRATOR));
      },
    });
    expect(counted).toEqual([2]);
    expect([
      documents.created(ORCHESTRATOR),
      documents.created(ORCHESTRATOR, one),
      documents.created(ORCHESTRATOR, two),
      // What your edits made.
      documents.created('you'),
    ]).toEqual([2, 1, 1, 4]);
    // Gone, or no longer an agent: not live.
    const { document } = documents.live(one);
    await commit(one, { ...document, nodes: document.nodes.filter(({ id }) => id !== 'first') });
    expect(documents.created(ORCHESTRATOR)).toBe(1);
  });
});
