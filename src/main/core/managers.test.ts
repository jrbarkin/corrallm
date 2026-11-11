import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { LeadGrants } from '../../shared/api/ops/leads';
import type { OpName } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { FakeConnector } from '../sessions/fake';
import { fakeConnector } from '../sessions/test-fake';
import type { AgentCaller, Caller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { APPROVALS_ONLY, QUESTIONS_ONLY } from './prompts/test-lead-world';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B24 C4 (Design §6): `{ party: 'manager' }` resolved at admission to the nearest ancestor lead
 * granted questions on a connection with an API route, else to you; re-addressed in place only away
 * from a lead that loses authority (demoted, held, grant off, deleted, moved out), to the next one
 * above or to you, never upgraded to a lead granted later; ask id, request key, deadline and
 * task unchanged.
 */

const TEAM = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02' as CanvasId;
const QUESTIONS: LeadGrants = QUESTIONS_ONLY;
const APPROVALS: LeadGrants = APPROVALS_ONLY;
const YOU = CALLERS.you;
const agentCaller = (agent: string): AgentCaller => ({
  kind: 'agent',
  canvas: TEAM,
  agent,
  generation: 1,
  session: `${agent}-session`,
});
const REQ = '3c9e4b5d-6f70-4182-9d3e-4f5a6b7c8d9e';
const WORK = agentCaller('work');
const TOP = agentCaller('top');
const QUESTION = {
  id: 'scope',
  header: 'Scope',
  text: 'How much of it?',
  options: [{ label: 'All' }, { label: 'Some' }],
  multiple: false,
  other: true,
};

/** top > mid > work, all on the App Server (API route), and `term` on a Terminal (none). */
const node = (id: string, parent?: string, connection = 'codex.app-server') => ({
  id,
  kind: 'agent',
  label: id,
  ...(parent === undefined ? {} : { parent }),
  position: { x: 0, y: 0 },
  adapter: 'codex',
  connection,
  role: `${id} role`,
});
const fileOf = (nodes: unknown[]) => ({
  format: 'corrallm',
  version: 3,
  id: TEAM,
  nodes,
  links: [],
});

let profile: string;
let core: Core;
let appServer: FakeConnector;
let opened = false;
const waiting: (() => void)[] = [];
/** A fake's turns wait here, between their events, until the test ends. */
const step = (): Promise<void> =>
  opened
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        waiting.push(resolve);
      });

async function start(nodes: unknown[]): Promise<void> {
  appServer = fakeConnector({ adapter: 'codex', step });
  const project = path.join(profile, 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(profile, 'team.corral');
  await writeFile(file, JSON.stringify(fileOf(nodes)));
  await keepCanvases(profile, { [TEAM]: { file, project } });
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      locale: 'en-GB',
      sessions: {
        callers: () => true,
        connectors: {
          'codex.app-server': appServer,
          'codex.terminal': fakeConnector({ adapter: 'codex' }),
        },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(TEAM);
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-managers-'));
});
afterEach(async () => {
  opened = true;
  for (const resolve of waiting.splice(0)) resolve();
  await core.close();
  opened = false;
  await rm(profile, { recursive: true, force: true });
});

function call(name: OpName, args: object, caller: Caller = YOU): Promise<OpResult<unknown>> {
  return core.call(name, { canvas: TEAM, ...args }, caller);
}
async function ok<T = Record<string, unknown>>(
  name: OpName,
  args: object,
  caller: Caller = YOU,
): Promise<T> {
  const result = await call(name, args, caller);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result)}`);
  return result.value as T;
}
const setLead = (agent: string, grants: LeadGrants | null = QUESTIONS) =>
  ok('agent.setLead', { agent, lead: grants === null ? null : { grants } });
async function find(id: string): Promise<Message | undefined> {
  const page = await ok<{ items: Message[] }>('messages', { limit: 200 });
  return page.items.find((message) => message.id === id);
}
const needs = async (): Promise<NeedsItem[]> =>
  (await ok<{ items: NeedsItem[] }>('needs', {})).items;
const ask = async (caller: AgentCaller = WORK, extra: object = {}): Promise<string> =>
  (
    await ok<{ id: string }>(
      'ask',
      { to: { party: 'manager' }, questions: [QUESTION], ...extra },
      caller,
    )
  ).id;

const THREE = [node('top'), node('mid', 'top'), node('work', 'mid')];

describe('a manager target, resolved at admission', () => {
  it('goes to the nearest ancestor lead granted questions, skipping one that holds only approvals', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    await setLead('mid', APPROVALS);
    const id = await ask();
    expect(await find(id)).toMatchObject({
      from: 'agent:work',
      to: 'agent:top',
      kind: 'prompt',
      ask: { via: 'manager' },
    });
    // Delivered as B21's agent-recipient ask: Needs shows it to you beside the lead.
    expect((await needs()).filter((item) => item.id === `ask/${id}`)).toMatchObject([
      { for: 'agent:top', by: ['agent:top', 'you'] },
    ]);
  });

  it('sends a message to that lead as an ordinary text message, still shown as to its manager', async () => {
    await start(THREE);
    await setLead('mid', QUESTIONS);
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'manager' }, body: 'Blocked.' },
      WORK,
    );
    expect(await find(id)).toMatchObject({ from: 'agent:work', to: 'agent:mid', kind: 'text' });
    expect(core.engines.canvas(TEAM)?.messages.displayOf(id)).toEqual({ via: 'manager' });
    // No message waits on you for it.
    expect((await needs()).filter((item) => item.kind === 'message')).toEqual([]);
  });

  it('is you when no lead above holds questions', async () => {
    await start(THREE);
    await setLead('top', APPROVALS);
    const id = await ask();
    expect((await find(id))?.to).toBe('you');
    expect(await needs()).toMatchObject([{ id: `ask/${id}`, for: 'you', by: ['you'] }]);
  });

  it('is never the asker: a lead asks the lead above it, or you', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    await setLead('mid', QUESTIONS);
    const id = await ask(agentCaller('mid'));
    expect((await find(id))?.to).toBe('agent:top');
    const own = await ask(TOP);
    expect((await find(own))?.to).toBe('you');
  });
});

describe('re-addressing in place', () => {
  it('moves an ask off a demoted lead to you, with its id, request, deadline unchanged', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    const id = await ask(WORK, { request: REQ, deadlineSeconds: 600 });
    const before = (await find(id))?.ask;
    await setLead('top', null);
    const after = await find(id);
    expect(after).toMatchObject({ id, to: 'you', state: 'delivered' });
    expect(after?.ask).toEqual(before);
    expect(await needs()).toMatchObject([{ id: `ask/${id}`, for: 'you', by: ['you'] }]);
    // The asker's repeat finds the same ask.
    expect(await ask(WORK, { request: REQ, deadlineSeconds: 600 })).toBe(id);
  });

  it('moves it to the next lead above when the nearest loses its grant', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    await setLead('mid', QUESTIONS);
    const id = await ask();
    expect((await find(id))?.to).toBe('agent:mid');
    await setLead('mid', APPROVALS);
    expect(await find(id)).toMatchObject({ id, to: 'agent:top' });
  });

  it('moves it away from a lead that is held, because its role changed', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    const id = await ask();
    await ok('agent.setRole', { agent: 'top', role: 'Another role.' });
    expect(await find(id)).toMatchObject({ id, to: 'you', state: 'delivered' });
  });

  it('moves it away from a lead deleted, rather than withdrawing it', async () => {
    await start(THREE);
    await setLead('mid', QUESTIONS);
    const id = await ask();
    await ok('canvas.delete', { nodes: ['mid'] });
    expect(await find(id)).toMatchObject({ id, to: 'you', state: 'delivered' });
    expect((await find(id))?.settled).toBeUndefined();
  });

  it('never upgrades a row already with you to a lead granted later', async () => {
    await start(THREE);
    const id = await ask();
    expect((await find(id))?.to).toBe('you');
    await setLead('top', QUESTIONS);
    expect((await find(id))?.to).toBe('you');
  });

  it('leaves the old lead a withdrawal note once the ask had reached it', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    const id = await ask();
    await vi.waitFor(() => {
      expect(appServer.sessions.flatMap((session) => session.sent).length).toBeGreaterThan(0);
    });
    await setLead('top', null);
    const store = core.engines.canvas(TEAM)?.messages;
    expect(store?.withdrawals('agent:top').map((one) => one.id)).toContain(id);
  });

  it('moves a message still pending to you, shown as to its manager, or up to the next lead', async () => {
    await start(THREE);
    await setLead('top', QUESTIONS);
    await setLead('mid', QUESTIONS);
    // Its first message is in its turn; the next waits behind it, still pending.
    await ok('message', { to: { party: 'manager' }, body: 'First.' }, WORK);
    await vi.waitFor(() => {
      expect(appServer.sessions.flatMap((session) => session.sent)).toHaveLength(1);
    });
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'manager' }, body: 'Stuck.' },
      WORK,
    );
    expect((await find(id))?.state).toBe('pending');
    const store = core.engines.canvas(TEAM)?.messages;
    expect((await find(id))?.to).toBe('agent:mid');
    await setLead('mid', null);
    // Nothing waits on the old lead for it any more; the next above takes it, and its display stays.
    expect(await find(id)).toMatchObject({ id, to: 'agent:top' });
    expect(store?.displayOf(id)).toEqual({ via: 'manager' });
  });

  it('moves a pending message to you when its lead is demoted, as a Needs item shown as to its manager', async () => {
    await start(THREE);
    await setLead('mid', QUESTIONS);
    await ok('message', { to: { party: 'manager' }, body: 'First.' }, WORK);
    await vi.waitFor(() => {
      expect(appServer.sessions.flatMap((session) => session.sent)).toHaveLength(1);
    });
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'manager' }, body: 'Stuck.' },
      WORK,
    );
    expect((await find(id))?.state).toBe('pending');
    await setLead('mid', null);
    expect(await find(id)).toMatchObject({ id, to: 'you', state: 'delivered' });
    expect((await needs()).filter((item) => item.id === `message/${id}`)).toMatchObject([
      { title: 'Message from work to its manager' },
    ]);
  });
});
