import { describe, expect, it } from 'vitest';
import { MAX_ROLE_LENGTH } from '../session';
import type { CanvasId } from '../canvas';
import type { AgentNode, CanvasDocument } from './canvas';
import { TEST_CATALOG } from '../test-model';
import { fromFile, toFile } from './file';
import { setConnection, setRole, setType } from './agent-ops';
import { insert } from './insert';
import { fillTemplate, placeholdersOf, withAgents, withConnections } from './templates';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
const context = { catalog: TEST_CATALOG, defaultAdapter: 'claude-code' };
const document = (): CanvasDocument => ({
  id: ID,
  arrange: false,
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Reviewer', role: 'Review the release.\n\tKeep useful formatting.' },
    },
  ],
  links: [],
});
const data = (doc: CanvasDocument) => (doc.nodes[0] as AgentNode).data;
const read = (text: string) => fromFile(text, TEST_CATALOG, context.defaultAdapter);
const file = (role: unknown, kind = 'agent') =>
  JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: ID,
    nodes: [{ id: 'a', kind, label: 'Reviewer', position: { x: 0, y: 0 }, role }],
    links: [],
  });

describe('authored roles in model documents and files', () => {
  it('sets and clears an independent role, preserving its interior formatting and unrelated nodes', () => {
    const before = document();
    const after = setRole(before, {
      agent: 'a',
      role: ' \n Release reviewer.\n\tCheck the rollout. \r\n',
    }).next;
    expect(data(after).role).toBe('Release reviewer.\n\tCheck the rollout.');
    expect(data(before).role).toBe('Review the release.\n\tKeep useful formatting.');
    expect(setRole(after, { agent: 'a', role: data(after).role }).next).toBe(after);
    expect(setRole(after, { agent: 'missing', role: 'unused' }).next).toBe(after);
    expect(data(setRole(after, { agent: 'a', role: ' \t\r\n ' }).next)).not.toHaveProperty('role');
    expect(data(setRole(after, { agent: 'a', role: undefined }).next)).not.toHaveProperty('role');
  });
  it('round-trips the authored role and omits absent or blank roles from saved data', () => {
    const before = document();
    expect(data(read(toFile(before))).role).toBe(data(before).role);
    expect(toFile(read(file(' \t\n ')))).not.toContain('"role"');
    expect(toFile(setRole(before, { agent: 'a', role: undefined }).next)).not.toContain('"role"');
    expect(data(read(file('  Reviewer.\n\tCheck carefully.  '))).role).toBe(
      'Reviewer.\n\tCheck carefully.',
    );
  });
  it.each([
    null,
    1,
    {},
    [],
    'bad\0role',
    'bad\x1brole',
    'bad\x7frole',
    'bad\u0085role',
    'x'.repeat(MAX_ROLE_LENGTH + 1),
  ])('rejects an invalid file role (%j)', (role) => {
    expect(() => read(file(role))).toThrow(/role/i);
  });
  it('validates in-memory authored roles before saving, and keeps roles off frames', () => {
    const before = document();
    data(before).role = 'unsafe\0role';
    expect(() => toFile(before)).toThrow(/role/i);
    expect(() => read(file('Frame role', 'group'))).toThrow(/role/i);
    const frame: CanvasDocument = {
      ...document(),
      nodes: [{ id: 'g', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Group' } }],
    };
    expect(setRole(frame, { agent: 'g', role: 'unused' }).next).toBe(frame);
  });
  it('discovers and fills role placeholders, clearing a role filled with whitespace', () => {
    const before = setRole(document(), {
      agent: 'a',
      role: '{{specialty}}\n\tScope: {{scope}}',
    }).next;
    expect(placeholdersOf(before)).toEqual(['specialty', 'scope']);
    expect(
      data(fillTemplate(before, { specialty: 'Release reviewer', scope: 'the API' })).role,
    ).toBe('Release reviewer\n\tScope: the API');
    expect(
      data(
        fillTemplate(setRole(before, { agent: 'a', role: '{{specialty}}' }).next, {
          specialty: ' \t\n ',
        }),
      ),
    ).not.toHaveProperty('role');
    expect(() => fillTemplate(before, { scope: 'bad\0scope' })).toThrow(/role/i);
  });
  it('preserves the role when switching adapter, importing and inserting a template with remapped IDs', () => {
    const before = document();
    const template = withConnections(
      withAgents(before, { a: 'codex' }, context),
      { a: 'codex.app-server' },
      context,
    );
    expect(data(template).role).toBe(data(before).role);
    expect(data(template).connection).toBe('codex.app-server');
    const switched = setConnection(
      setType(before, { agent: 'a', adapter: 'codex' }, context).next,
      { agent: 'a', connection: 'codex.app-server' },
      context,
    ).next;
    expect(data(switched).role).toBe(data(before).role);
    const imported = read(toFile(switched));
    let count = 0;
    const inserted = insert(
      { ...before, nodes: [] },
      imported,
      {},
      { newId: () => `imported-${String(++count)}` },
    ).next;
    const agent = inserted.nodes.find((node) => node.type === 'agent');
    expect(agent?.id).not.toBe('a');
    expect(agent?.data.role).toBe(data(before).role);
    expect(agent?.data.adapter).toBe('codex');
  });
});
