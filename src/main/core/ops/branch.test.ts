import { describe, expect, it, vi } from 'vitest';

import { AgentId, WorktreeId } from '../../../shared/api/ids';
import { OPS } from '../../../shared/api/registry';
import { SURFACE } from '../../../shared/api/surface';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { createDispatcher } from '../call';
import type { Publication } from '../call';
import type { OutsideCaller } from '../caller';
import type { Engines, OpenCanvas } from '../engines';
import { resolvers } from '../reach';
import { ruleChecks } from '../rules';
import { CALLERS, CANVAS, isLead } from '../test-registry';
import { branchOps } from './branch';
import { batchOps } from './batch';
import type { WorktreeServices } from './worktree';

const oid = 'a'.repeat(40);
const checkpoint = 'c'.repeat(40);
const merged = 'b'.repeat(40);
const source = { ref: 'refs/heads/corrallm/profile/worker', oid };
const into = { ref: 'refs/heads/main', oid };
const request = '33333333-3333-4333-8333-333333333333';
const args = { canvas: CANVAS, agent: 'worker', source, into, request };

function world() {
  let document: CanvasDocument = {
    id: CANVAS,
    arrange: false,
    nodes: ['lead', 'helper', 'worker', 'apprentice', 'peer'].map((id) => ({
      id,
      type: 'agent',
      position: { x: 0, y: 0 },
      ...(id === 'helper'
        ? { parentId: 'lead' }
        : id === 'apprentice'
          ? { parentId: 'worker' }
          : {}),
      data: { label: id },
    })),
    links: [
      { source: 'lead', target: 'worker' },
      { source: 'worker', target: 'peer' },
    ],
  };
  const open = {
    get document() {
      return document;
    },
  } as OpenCanvas;
  const engines = {
    canvas: (id: string) => (id === CANVAS ? open : undefined),
  } as unknown as Engines;
  const diff = vi.fn<NonNullable<WorktreeServices['diff']>>().mockImplementation((at) =>
    Promise.resolve({
      ok: true,
      value: {
        agent: AgentId.parse(at.agent),
        workspace: WorktreeId.parse('22222222-2222-4222-8222-222222222222'),
        shared: ['worker', 'apprentice']
          .filter((one) => at.viewer.kind === 'you' || at.viewer.reached.has(one))
          .map((one) => AgentId.parse(one)),
        source: { ...source, onBranch: true },
        base: into,
        into,
        committed: { files: 0, complete: true },
        uncommitted: { changed: 0, untracked: 0, partlyStaged: 0, complete: true, digest: null },
        files: [],
        next: null,
      },
    }),
  );
  const merge = vi.fn<NonNullable<WorktreeServices['merge']>>().mockResolvedValue({
    ok: true,
    value: {
      outcome: 'merged',
      source: oid,
      into: { ref: into.ref, before: oid, after: merged },
      mergeCommit: merged,
    },
  });
  const worktrees: WorktreeServices = {
    diff,
    merge,
    proposals: { raise: vi.fn() },
    nameOf: () => undefined,
    workspaces: { worktree: () => undefined },
  };
  const publication: Publication = {
    mark: () => 0,
    attribute: vi.fn(),
    receipts: vi.fn<Publication['receipts']>((topics) =>
      Promise.resolve(topics.includes(`worktrees:${CANVAS}`) ? { [`worktrees:${CANVAS}`]: 3 } : {}),
    ),
  };
  let clock = 0;
  const core = createDispatcher(
    {
      surface: {
        'branch.diff': SURFACE['branch.diff'],
        'branch.merge': SURFACE['branch.merge'],
        'canvas.batch': SURFACE['canvas.batch'],
      },
      ops: {
        'branch.diff': OPS['branch.diff'],
        'branch.merge': OPS['branch.merge'],
        'canvas.batch': OPS['canvas.batch'],
      },
      implementations: { ...branchOps({ worktrees, engines, isLead }), ...batchOps() },
      rules: ruleChecks(engines, () => undefined),
    },
    {
      isLead,
      resolvers: resolvers(engines, isLead),
      check: true,
      publication,
      now: () => (clock += 1000),
    },
  );
  return {
    core,
    diff,
    merge,
    publication,
    remove: () => {
      document = { ...document, nodes: [] };
    },
  };
}

describe('registered branch services', () => {
  it.each(['you', 'lead', 'worker', 'outside-read', 'outside-write'] as const)(
    'builds %s’s diff viewer from its own worktree-list reach',
    async (party) => {
      const at = world();
      const result = await at.core.call(
        'branch.diff',
        { canvas: CANVAS, agent: 'worker', limit: 1, after: 'e30' },
        CALLERS[party],
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          shared:
            party === 'you' || party.startsWith('outside') ? ['worker', 'apprentice'] : ['worker'],
        },
      });
      expect(at.diff).toHaveBeenCalledOnce();
      const read = at.diff.mock.calls[0]?.[0];
      expect(read).toMatchObject({
        canvas: CANVAS,
        agent: 'worker',
        limit: 1,
        after: 'e30',
        viewer: { kind: party === 'you' ? 'you' : 'token' },
      });
      if (party !== 'you') expect(read?.document).toBeDefined();
      expect(at.merge).not.toHaveBeenCalled();
    },
  );

  it.each(['you', 'outside-write'] as const)(
    'passes %s’s merge identity, pins and signal, and publishes its settled worktrees receipt',
    async (party) => {
      const at = world();
      const result = await at.core.call(
        'branch.merge',
        { ...args, uncommitted: { choice: 'leave' } },
        CALLERS[party],
      );
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'merged', revs: { [`worktrees:${CANVAS}`]: 3 } },
      });
      const call = at.merge.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        ...args,
        uncommitted: { choice: 'leave' },
        caller:
          party === 'you'
            ? { key: 'you', requester: 'you' }
            : {
                key: `token:${(CALLERS[party] as OutsideCaller).token}`,
                requester: 'outside:orchestrator',
              },
      });
      expect(call?.signal).toBeInstanceOf(AbortSignal);
      expect(call?.authorized?.()).toBe(true);
      at.remove();
      if (party === 'you') expect(call?.authorized?.()).toBe(true);
      else
        expect(() => call?.authorized?.()).toThrow(expect.objectContaining({ code: 'not-found' }));
      expect(at.diff).not.toHaveBeenCalled();
    },
  );

  it('maps only an unrecorded checkpoint to checkpointRecorded false', async () => {
    const at = world();
    at.merge.mockResolvedValue({
      ok: true,
      value: {
        outcome: 'merged',
        source: checkpoint,
        into: { ref: into.ref, before: oid, after: merged },
        mergeCommit: merged,
        checkpoint,
        recorded: false,
      },
    });
    const result = await at.core.call(
      'branch.merge',
      { ...args, uncommitted: { choice: 'commit', digest: 'd'.repeat(64) } },
      CALLERS.you,
    );
    expect(result).toMatchObject({ ok: true, value: { checkpoint, checkpointRecorded: false } });
    if (result.ok) expect(result.value).not.toHaveProperty('recorded');
  });

  it('preserves a service conflict without a second service call', async () => {
    const at = world();
    at.diff.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', sentence: 'Review this work again.' },
    });
    expect(
      await at.core.call('branch.diff', { canvas: CANVAS, agent: 'worker' }, CALLERS.you),
    ).toEqual({ ok: false, error: { code: 'conflict', sentence: 'Review this work again.' } });
    expect(at.diff).toHaveBeenCalledOnce();
    expect(at.merge).not.toHaveBeenCalled();
  });
});

describe('T9: merge-permits on the registered operation', () => {
  it('refuses a no-merge writer and every agent and read token before the merge service', async () => {
    const at = world();
    const writer = CALLERS['outside-write'] as OutsideCaller;
    const refused = await at.core.call('branch.merge', args, { ...writer, merge: false });
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    if (!refused.ok) expect(refused.error.sentence).toContain('--no-merge');
    for (const party of ['lead', 'worker', 'outside-read'] as const)
      expect(await at.core.call('branch.merge', args, CALLERS[party])).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    expect(at.merge).not.toHaveBeenCalled();
  });

  it('admits no merge command through a canvas batch', async () => {
    const at = world();
    expect(
      await at.core.call(
        'canvas.batch',
        { canvas: CANVAS, ops: [{ op: 'branch.merge', args }] },
        CALLERS['outside-write'],
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(at.merge).not.toHaveBeenCalled();
  });
});
