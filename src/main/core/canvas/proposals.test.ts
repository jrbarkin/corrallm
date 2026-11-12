import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { MessageStore, MessageTable } from '../delivery/messages';
import type { Staged } from '../delivery/messages';
import type { Store } from '../store/store';
import { onDisk, openTestStore } from '../store/test-store';
import type { Connection } from '../store/sqlite';
import { Proposals } from './proposals';
import type { Proposal } from './proposals';

/*
 * The proposals waiting for you (R4): raised in a write that reads the open ones (a blocking
 * write), settled in a planned one that reads nothing, a proposal settled already failing only the
 * write that settles it again.
 */

const CANVAS = '11111111-1111-4111-8111-111111111111' as CanvasId;

let profile: string;
let store: Store;
let memory: CanvasMemory;
let disk: Connection;
let messages: MessageStore;
let proposals: Proposals;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-proposals-'));
  store = await openTestStore(profile);
  disk = onDisk(profile);
  memory = new CanvasMemory(store);
  messages = new MessageStore(CANVAS, new MessageTable(store, memory), () => 1000);
  await messages.load();
  proposals = new Proposals({
    store,
    messages: () => Promise.resolve(messages),
    conversations: () => Promise.resolve(new Set()),
    newId: () => '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51',
  });
  // A proposal refers to its canvas's document.
  await store.write(() => {
    memory.ensure(CANVAS);
    store.run(
      'INSERT INTO document (canvas_id, rev, arrange, by_party, changed_at) VALUES (?, 0, 0, ?, 0)',
      CANVAS,
      'you',
    );
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  disk.close();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

async function raised(): Promise<Proposal> {
  const id = await proposals.raise(CANVAS, {
    op: 'canvas.close',
    args: { canvas: CANVAS },
    by: 'outside:orchestrator',
    touched: { 'node/lead': 1 },
    lost: { what: 'close the canvas', title: 'Close the canvas?' },
  });
  const proposal = proposals.get(CANVAS, id);
  if (proposal === undefined) throw new Error('No proposal.');
  return proposal;
}

const outcomes = () => disk.prepare('SELECT outcome, settled_by FROM proposal').all();

describe('Proposals', () => {
  it('settles one in a planned write, which reads nothing, giving its proposer a record', async () => {
    const proposal = await raised();
    const blocking = vi.spyOn(store, 'writeBlocking');
    const settled = await proposals.settle(proposal, 'refused', 'you');
    expect(blocking).not.toHaveBeenCalled();
    expect(settled).toMatchObject({ kind: 'settled', to: 'outside:orchestrator' });
    expect(outcomes()).toEqual([{ outcome: 'refused', settled_by: 'you' }]);
    expect(proposals.open(CANVAS)).toEqual([]);
  });

  it('fails only the write that settles one settled already, keeping its neighbours', async () => {
    const proposal = await raised();
    await proposals.settle(proposal, 'refused', 'you');
    const settlement = await proposals.settlement(proposal, 'allowed', 'you');
    let staged: Staged | undefined;
    const [again, neighbour] = await Promise.allSettled([
      store.write(
        () => {
          staged = settlement.within();
        },
        (error) => staged?.undo(error),
      ),
      store.write(() => {
        memory.ensure('22222222-2222-4222-8222-222222222222' as CanvasId);
      }),
    ]);
    expect(again).toMatchObject({
      status: 'rejected',
      reason: { message: `${proposal.id} was settled already.` },
    });
    expect(neighbour.status).toBe('fulfilled');
    expect(settlement.record).toBeUndefined();
    expect(outcomes()).toEqual([{ outcome: 'refused', settled_by: 'you' }]);
  });
});
