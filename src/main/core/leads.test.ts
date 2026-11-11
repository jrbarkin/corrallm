import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { CanvasMemory } from '../memory';
import { CATALOG } from '../sessions/adapters';
import { Documents } from './canvas/documents';
import { commitDocument } from './canvas/test-documents';
import { LeadStore } from './leads';
import type { Grants } from './leads';
import type { Store } from './store/store';
import { SYSTEM_DEPS } from './store/store';
import { openTestStore, readOnDisk, refuseWrites, writeOnDisk } from './store/test-store';

/*
 * Who leads (B24 C1, C2): an agent you made a lead of the agents nested in it, kept in the core's
 * database (`lead`, schema 14) and in memory, never in a canvas file; what it was when you did (its
 * role's fingerprint, adapter and connection), held at the first commit that changes any of it,
 * until you confirm it; its row deleted in the write of the commit that removes its agent, and
 * pruned of agents gone as a canvas's document loads. And the outside orchestrators, by their
 * token's name, you let answer approvals (`outside_grant`, Q3).
 */

const CANVAS = '0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10' as CanvasId;
const GRANTS: Grants = { questions: true, plans: false, approvals: true };

/** An agent `id` on its fixed endpoint, but for what `data` says (undefined: none). */
const agent = (
  id: string,
  data: { [K in keyof AgentNode['data']]?: AgentNode['data'][K] | undefined } = {},
  parentId?: string,
) =>
  ({
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    ...(parentId === undefined ? {} : { parentId }),
    data: Object.fromEntries(
      Object.entries({
        label: id,
        adapter: 'codex',
        connection: 'codex.app-server',
        ...data,
      }).filter(([, value]) => value !== undefined),
    ) as unknown as AgentNode['data'],
  }) as AgentNode;
const canvasOf = (...nodes: AgentNode[]): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes,
  links: [],
});
/** The canvas as it starts: `lead`, with `helper` nested inside it. */
const START = canvasOf(agent('lead', { role: 'Leads' }), agent('helper', {}, 'lead'));

let profile: string;
let store: Store;
let memory: CanvasMemory;
let documents: Documents;
let leads: LeadStore;
/** What the lead store said changed: the canvas, and the lead you changed (none: not one lead). */
let heard: { canvas: CanvasId; lead?: string | undefined }[] = [];

/** A lead store and documents over the profile's database, as a core opens them. */
function open(): void {
  memory = new CanvasMemory(store);
  leads = new LeadStore({
    store,
    memory,
    catalog: CATALOG,
    document: (canvas) => documents.loaded(canvas)?.document,
    now: () => 1000,
    changed: (canvas, lead) => heard.push({ canvas, lead }),
  });
  leads.load();
  documents = new Documents({ store, memory, catalog: CATALOG, leads });
}

beforeEach(async () => {
  heard = [];
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-leads-'));
  store = await openTestStore(profile, SYSTEM_DEPS);
  open();
  documents.create(CANVAS, 'you');
  await commitDocument(documents, CANVAS, START);
});

afterEach(async () => {
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

/** What the database keeps of the canvas's leads. */
const rows = () =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare(
        'SELECT agent_id, grants, fingerprint, held, changed_at FROM lead WHERE canvas_id = ?',
      )
      .all(CANVAS)
      .map((row) => ({
        agent_id: row.agent_id,
        grants: JSON.parse(String(row.grants)) as unknown,
        fingerprint: JSON.parse(String(row.fingerprint)) as unknown,
        held: row.held,
        changed_at: row.changed_at,
      })),
  );
/** The canvas's document now. */
const now = () => documents.live(CANVAS).document;
/** Commits `next` over the canvas's document. */
const commit = (next: CanvasDocument) => commitDocument(documents, CANVAS, next);
/** Makes `id` a lead with `grants`, as agent.setLead does once it checked its agent. */
function makeLead(id = 'lead', grants: Grants = GRANTS): Promise<void> {
  const node = now().nodes.find((one) => one.id === id);
  if (node?.type !== 'agent') throw new Error(`No agent ${id}`);
  const fingerprint = leads.fingerprintOf(node.data);
  if (fingerprint === undefined) throw new Error(`${id}'s agent isn't chosen`);
  return leads.set(CANVAS, id, { grants, fingerprint });
}
/** A core opened again on the same database: what its lead store reads back. */
async function reopen(): Promise<void> {
  open();
  await documents.load(CANVAS);
}

describe('what a change says changed', () => {
  it('names the lead you made, confirmed or removed, and no lead for a grant or a hold', async () => {
    await makeLead();
    await makeLead();
    await leads.set(CANVAS, 'lead', null);
    expect(heard.map(({ lead }) => lead)).toEqual(['lead', 'lead', 'lead']);
    heard.length = 0;
    await leads.setGrant(CANVAS, 'orchestrator', true);
    expect(heard).toEqual([{ canvas: CANVAS, lead: undefined }]);
    heard.length = 0;
    await makeLead();
    heard.length = 0;
    await commit(canvasOf(agent('lead', { role: 'Another role.' }), agent('helper', {}, 'lead')));
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every(({ lead }) => lead === undefined)).toBe(true);
  });
});

describe('a lead', () => {
  it('is kept with its grants and what its agent was, on disk before it resolves', async () => {
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
    await makeLead();
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(leads.isLead(CANVAS, 'helper')).toBe(false);
    expect(leads.grantsOf(CANVAS, 'lead')).toEqual(GRANTS);
    expect(rows()).toEqual([
      {
        agent_id: 'lead',
        grants: { v: 1, ...GRANTS },
        fingerprint: {
          v: 1,
          // Its role's SHA-256, never its text.
          role: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
          adapter: 'codex',
          connection: 'codex.app-server',
        },
        held: null,
        changed_at: 1000,
      },
    ]);
    expect(JSON.stringify(rows())).not.toContain('Leads');
    await reopen();
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(leads.view(CANVAS)).toEqual([{ agent: 'lead', grants: GRANTS, held: null }]);
  });

  it('is no lead once removed, its row gone', async () => {
    await makeLead();
    await leads.set(CANVAS, 'lead', null);
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
    expect(leads.grantsOf(CANVAS, 'lead')).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it('records the fingerprint of the endpoint its agent resolves to, with no role as none', () => {
    expect(leads.fingerprintOf(agent('a', { connection: undefined }).data)).toEqual({
      v: 1,
      role: 'none',
      adapter: 'codex',
      // The adapter's first, as agentEndpoint resolves an omitted connection.
      connection: CATALOG.adapters.find((one) => one.id === 'codex')?.connections[0]?.id,
    });
    // Unchosen and unavailable agents can't lead.
    expect(
      leads.fingerprintOf(agent('a', { adapter: undefined, connection: undefined }).data),
    ).toBeUndefined();
    expect(leads.fingerprintOf(agent('a', { adapter: 'zed', connection: undefined }).data)).toBe(
      undefined,
    );
  });

  it.each([
    ['role', agent('lead', { role: 'Leads differently' })],
    ['adapter', agent('lead', { adapter: 'claude-code', connection: 'claude-code.terminal' })],
    ['connection', agent('lead', { role: 'Leads', connection: 'codex.terminal' })],
  ] as const)(
    'is held once a commit changes its %s, durably, until you confirm it',
    async (reason, changed) => {
      await makeLead();
      await commit(canvasOf(changed, agent('helper', {}, 'lead')));
      expect(leads.isLead(CANVAS, 'lead')).toBe(false);
      expect(leads.grantsOf(CANVAS, 'lead')).toBeUndefined();
      expect(rows()).toMatchObject([{ agent_id: 'lead', held: reason }]);
      expect(leads.view(CANVAS)).toEqual([{ agent: 'lead', grants: GRANTS, held: reason }]);
      // Changing it back keeps it held: no edit and its revert re-arm a lead unasked.
      await commit(START);
      expect(leads.isLead(CANVAS, 'lead')).toBe(false);
      expect(rows()).toMatchObject([{ agent_id: 'lead', held: reason }]);
      await reopen();
      expect(leads.isLead(CANVAS, 'lead')).toBe(false);
      // The same grants again confirm it, as its agent is now.
      await makeLead();
      expect(leads.isLead(CANVAS, 'lead')).toBe(true);
      expect(rows()).toMatchObject([{ agent_id: 'lead', held: null }]);
    },
  );

  it('keeps leading through a commit that changes nothing it was made a lead as', async () => {
    await makeLead();
    await commit(
      canvasOf(agent('lead', { role: 'Leads', label: 'Head' }), agent('helper', {}, 'lead')),
    );
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(rows()).toMatchObject([{ agent_id: 'lead', held: null }]);
  });

  it('goes with its agent, in the write of the commit that removes it; a failed one keeps it', async () => {
    await makeLead();
    // The lead's row can't be written: the commit removing its agent fails whole.
    const release = refuseWrites(profile, 'lead', 'The disk is full.');
    await expect(commit(canvasOf(agent('helper')))).rejects.toThrow(/The disk is full/);
    release();
    expect(now().nodes.map((node) => node.id)).toEqual(['lead', 'helper']);
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(rows()).toHaveLength(1);

    await commit(canvasOf(agent('helper')));
    expect(rows()).toEqual([]);
    expect(leads.view(CANVAS)).toEqual([]);
    // A later agent of the same id is no lead.
    await commit(START);
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
  });

  it('goes as a canvas’s document loads without its agent', async () => {
    await makeLead();
    writeOnDisk(
      profile,
      `INSERT INTO lead (canvas_id, agent_id, grants, fingerprint, changed_at)
       SELECT canvas_id, 'gone', grants, fingerprint, changed_at FROM lead`,
    );
    await reopen();
    expect(rows().map((row) => row.agent_id)).toEqual(['lead']);
    expect(leads.isLead(CANVAS, 'gone')).toBe(false);
  });

  it('is held as a document loads with its agent changed since, as a commit holds it', async () => {
    await makeLead();
    writeOnDisk(profile, `UPDATE node SET role = 'Changed elsewhere' WHERE id = 'lead'`);
    await reopen();
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
    expect(rows()).toMatchObject([{ agent_id: 'lead', held: 'role' }]);
  });

  it('goes with its canvas', async () => {
    await makeLead();
    await store.writeBlocking(() => {
      store.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS);
    });
    expect(rows()).toEqual([]);
  });

  it('is no lead once canvas memory forgets its canvas, though its document is still loaded', async () => {
    await makeLead();
    await leads.setGrant(CANVAS, 'orchestrator', true);
    expect(await memory.forget(CANVAS)).toBe(true);
    expect(rows()).toEqual([]);
    // Nothing of it is kept in memory either: no lead comes back as its canvas is kept again.
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
    expect(leads.view(CANVAS)).toEqual([]);
    expect(leads.granted(CANVAS)).toEqual([]);
  });

  it('keeps existing leads and outside grants when a planned write ensures another canvas', async () => {
    await makeLead();
    await leads.setGrant(CANVAS, 'orchestrator', true);
    await store.write(() => {
      memory.ensure('11111111-1111-4111-8111-111111111111' as CanvasId);
    });
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(leads.grantsOf(CANVAS, 'lead')).toEqual(GRANTS);
    expect(leads.granted(CANVAS)).toEqual(['orchestrator']);
    expect(rows()).toMatchObject([{ agent_id: 'lead', held: null }]);
    await reopen();
    expect(leads.isLead(CANVAS, 'lead')).toBe(true);
    expect(leads.granted(CANVAS)).toEqual(['orchestrator']);
  });

  it('is no lead where its row can’t be read, which is kept as it is', async () => {
    await makeLead();
    writeOnDisk(profile, `UPDATE lead SET grants = '{"v":2}'`);
    await reopen();
    expect(leads.isLead(CANVAS, 'lead')).toBe(false);
    expect(leads.view(CANVAS)).toEqual([]);
    expect(rows()).toMatchObject([{ agent_id: 'lead', grants: { v: 2 } }]);
  });
});

describe('an outside grant', () => {
  it('is kept by its token’s name, on disk before it resolves, until removed', async () => {
    expect(leads.granted(CANVAS)).toEqual([]);
    expect(await leads.setGrant(CANVAS, 'orchestrator', true)).toBe(true);
    expect(await leads.setGrant(CANVAS, 'orchestrator', true)).toBe(false);
    expect(leads.granted(CANVAS)).toEqual(['orchestrator']);
    const grants = () =>
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT name, changed_at FROM outside_grant WHERE canvas_id = ?').all(CANVAS),
      );
    expect(grants()).toEqual([{ name: 'orchestrator', changed_at: 1000 }]);
    await reopen();
    expect(leads.granted(CANVAS)).toEqual(['orchestrator']);
    expect(await leads.setGrant(CANVAS, 'orchestrator', false)).toBe(true);
    expect(await leads.setGrant(CANVAS, 'orchestrator', false)).toBe(false);
    expect(leads.granted(CANVAS)).toEqual([]);
    expect(grants()).toEqual([]);
  });

  it('changes nothing it keeps where its write fails', async () => {
    const release = refuseWrites(profile, 'outside_grant', 'The disk is full.');
    await expect(leads.setGrant(CANVAS, 'orchestrator', true)).rejects.toThrow(/disk is full/);
    release();
    expect(leads.granted(CANVAS)).toEqual([]);
  });
});
