import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import type { Connection } from '../store/sqlite';
import type { Store } from '../store/store';
import { onDisk, openTestStore, writeOnDisk } from '../store/test-store';
import { MergeJournal, MergeJournalError } from './merge-journal';
import type { MergeIntent, NewMergeJob } from './merge-journal';
import { WorkspaceStore } from './store';

/*
 * The merge journal (B9b Design §9 C8, schema 5's merge_job): each merge recorded, within a write,
 * before it is installed, its intent never changing, its phase and outcome compare-and-set, one
 * going on per repository, a caller's request found again across a restart; what it is given
 * checked, and what it reads back read only as it wrote it.
 */

const CANVAS = '11111111-1111-4111-8111-111111111111' as CanvasId;
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const OTHER_REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e71';
const WORKSPACE = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
const J1 = 'c0ffee00-0000-4000-8000-000000000001';
const J2 = 'c0ffee00-0000-4000-8000-000000000002';
const J3 = 'c0ffee00-0000-4000-8000-000000000003';
const R1 = 'deadbeef-0000-4000-8000-000000000001';
const R2 = 'deadbeef-0000-4000-8000-000000000002';
const R3 = 'deadbeef-0000-4000-8000-000000000003';
const TOKEN = 'token:0f1e2d3c-4b5a-4968-8776-655443322110';

let profile: string;
let store: Store;
let now: number;
let journal: MergeJournal;
let reader: Connection;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-merge-journal-'));
  store = await openTestStore(profile);
  reader = onDisk(profile);
  now = 1000;
  journal = new MergeJournal({ store, now: () => now });
  const memory = new CanvasMemory(store);
  const workspaces = new WorkspaceStore({ store });
  await store.write(() => {
    memory.ensure(CANVAS);
    for (const [id, at] of [
      [REPOSITORY, '/work/app'],
      [OTHER_REPOSITORY, '/work/other'],
    ] as const) {
      workspaces.addRepository({
        id,
        pickedRoot: at,
        realRoot: at,
        commonDir: `${at}/.git`,
        identity: `identity ${at}`,
        rootKind: 'project',
        ownedRoot: `${at}/.corral/worktrees/p`,
      });
    }
  });
});

afterEach(async () => {
  reader.close();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

const P = 'a'.repeat(40);
const M = 'b'.repeat(40);
const TIP = 'c'.repeat(40);

function intent(changes: Partial<MergeIntent> = {}): MergeIntent {
  return {
    version: 1,
    args: 'd'.repeat(64),
    requester: 'you',
    destination: {
      root: '/work/app',
      gitDir: '/work/app/.git',
      commonDir: '/work/app/.git',
      identity: 'identity /work/app',
      branch: 'refs/heads/main',
      oid: P,
    },
    merge: { tree: 'e'.repeat(40), commit: M },
    source: {
      ref: `refs/heads/corrallm/p/${WORKSPACE}`,
      tip: TIP,
      gitDir: `/work/app/.git/worktrees/${WORKSPACE}`,
      checkpoint: null,
      digest: null,
    },
    origHead: null,
    ...changes,
  };
}

function job(changes: Partial<NewMergeJob> = {}): NewMergeJob {
  return {
    id: J1,
    canvas: CANVAS,
    agent: 'builder',
    workspace: WORKSPACE,
    repository: REPOSITORY,
    callerKey: 'you',
    requestId: R1,
    intent: intent(),
    ...changes,
  };
}

const rows = () => reader.prepare('SELECT * FROM merge_job ORDER BY created_at, id').all();

describe('the merge journal', () => {
  it('records a merge within a write, on disk once it resolves, installing and going on', async () => {
    const recorded = await journal.write((j) => j.record(job()));
    expect(recorded).toEqual({
      ...job(),
      phase: 'installing',
      outcome: null,
      sentence: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(rows()).toHaveLength(1);
    expect(journal.job(J1)).toEqual(recorded);
    expect(journal.open()).toEqual([recorded]);
    expect(journal.openIn(REPOSITORY)).toEqual(recorded);
    expect(journal.openIn(OTHER_REPOSITORY)).toBeUndefined();
    expect(journal.latest(WORKSPACE)).toEqual(recorded);
  });

  it('finds a caller’s request again, and only that caller’s', async () => {
    await journal.write((j) => j.record(job()));
    expect(journal.byRequest('you', R1)?.id).toBe(J1);
    expect(journal.byRequest(TOKEN, R1)).toBeUndefined();
    expect(journal.byRequest('you', R2)).toBeUndefined();
    // The same request again, settled or not, is refused: it is answered from the row instead.
    await expect(journal.write((j) => j.record(job({ id: J2 })))).rejects.toThrow(
      MergeJournalError,
    );
  });

  it('keeps one merge going on per repository, any number settled', async () => {
    await journal.write((j) => j.record(job()));
    await expect(
      journal.write((j) => j.record(job({ id: J2, requestId: R2 }))),
    ).rejects.toMatchObject({ code: 'refused' });
    await journal.write((j) =>
      j.record(job({ id: J3, requestId: R3, repository: OTHER_REPOSITORY })),
    );
    await journal.write((j) => j.settle(J1, { outcome: 'refused', sentence: 'Nothing changed.' }));
    await journal.write((j) => j.record(job({ id: J2, requestId: R2 })));
    expect(journal.open().map(({ id }) => id)).toEqual([J2, J3]);
  });

  it('moves a merge’s phase and settles it from where its caller thinks it is', async () => {
    await journal.write((j) => j.record(job()));
    now = 2000;
    await expect(
      journal.write((j) => j.advance(J1, { from: 'installed', to: 'published' })),
    ).rejects.toMatchObject({ code: 'stale' });
    const installed = await journal.write((j) =>
      j.advance(J1, { from: 'installing', to: 'installed' }),
    );
    expect(installed).toMatchObject({ phase: 'installed', outcome: null, updatedAt: 2000 });
    const merged = await journal.write((j) => j.settle(J1, { outcome: 'merged', phase: 'done' }));
    expect(merged).toMatchObject({ phase: 'done', outcome: 'merged', sentence: null });
    await expect(journal.write((j) => j.settle(J1, { outcome: 'held' }))).rejects.toMatchObject({
      code: 'stale',
    });
    expect(journal.open()).toEqual([]);
    // Its intent never changes.
    expect(journal.job(J1)?.intent).toEqual(intent());
  });

  it('keeps a merged checkpoint whose agent’s index wasn’t reset yet, until it is', async () => {
    const withCheckpoint = intent({
      source: { ...intent().source, checkpoint: 'f'.repeat(40), digest: '1'.repeat(64) },
    });
    await journal.write((j) => j.record(job({ intent: withCheckpoint })));
    await journal.write((j) => j.settle(J1, { outcome: 'merged', phase: 'published' }));
    expect(journal.resetsPending().map(({ id }) => id)).toEqual([J1]);
    expect(await journal.write((j) => j.finishReset(J1))).toMatchObject({
      outcome: 'merged',
      phase: 'done',
    });
    expect(journal.resetsPending()).toEqual([]);
    await expect(journal.write((j) => j.finishReset(J1))).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('supersedes a held merge into a checkout once another is recorded into the same one', async () => {
    await journal.write((j) => j.record(job()));
    await journal.write((j) => j.settle(J1, { outcome: 'held', sentence: 'Check git status.' }));
    // Another checkout of the same repository proves nothing of that one.
    const elsewhere = intent({
      destination: {
        ...intent().destination,
        root: '/work/linked',
        gitDir: '/work/app/.git/worktrees/linked',
      },
    });
    await journal.write((j) => j.record(job({ id: J2, requestId: R2, intent: elsewhere })));
    expect(journal.job(J1)?.outcome).toBe('held');
    await journal.write((j) => j.settle(J2, { outcome: 'refused', sentence: 'Nothing changed.' }));
    await journal.write((j) => j.record(job({ id: J3, requestId: R3 })));
    expect(journal.job(J1)).toMatchObject({ outcome: 'superseded', sentence: 'Check git status.' });
    expect(journal.latest(WORKSPACE)?.id).toBe(J3);
    // A held one is also superseded when asked.
    await journal.write((j) => j.settle(J3, { outcome: 'held', sentence: 'Check git status.' }));
    expect(await journal.write((j) => j.supersede(J3))).toMatchObject({ outcome: 'superseded' });
  });

  it('checks what it is given', async () => {
    const bad: Partial<NewMergeJob>[] = [
      { id: 'job' },
      { canvas: 'canvas' as CanvasId },
      { agent: '' },
      { workspace: 'w' },
      { callerKey: 'window:1' },
      { callerKey: 'token:x' },
      { requestId: 'r' },
      { intent: intent({ requester: 'agent:builder' }) },
      { intent: intent({ args: 'x' }) },
      { intent: intent({ origHead: 'HEAD' }) },
      { intent: intent({ merge: { tree: 'e'.repeat(40), commit: 'm' } }) },
      { intent: intent({ destination: { ...intent().destination, root: 'relative' } }) },
      { intent: intent({ destination: { ...intent().destination, branch: 'main' } }) },
      { intent: intent({ destination: { ...intent().destination, oid: 'a'.repeat(64) } }) },
      { intent: intent({ source: { ...intent().source, ref: '-x' } }) },
      { intent: intent({ source: { ...intent().source, checkpoint: 'f'.repeat(40) } }) },
    ];
    for (const changes of bad) {
      await expect(
        journal.write((j) => j.record(job(changes))),
        JSON.stringify(changes),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await journal.write((j) => j.record(job()));
    await expect(
      journal.write((j) => j.settle(J1, { outcome: 'held', sentence: 'x'.repeat(2049) })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(rows()).toHaveLength(1);
  });

  it('reads a row back only as it wrote it: anything else fails its read, never taken for safe', async () => {
    await journal.write((j) => j.record(job()));
    writeOnDisk(
      profile,
      `UPDATE merge_job SET intent = json_set(intent, '$.merge.commit', 'HEAD') WHERE id = '${J1}'`,
    );
    expect(() => journal.job(J1)).toThrow(/can’t be read/);
    expect(() => journal.open()).toThrow(/can’t be read/);
  });
});
