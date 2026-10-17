import { describe, expect, it } from 'vitest';

import { MAX_ROLE_LENGTH } from '../../shared/session';
import { fromFile, toFile } from './file';
import { setAgent, setConnection, setRole } from './graph';
import type { Graph } from './graph';
import { insertGraph } from './insert';
import { fillTemplate, placeholdersOf, withAgents, withConnections } from './templates';

const graph = (): Graph => ({
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Reviewer', role: 'Review the release.\n\tKeep useful formatting.' },
    },
  ],
  edges: [],
});
const file = (role: unknown, kind = 'agent') =>
  JSON.stringify({
    format: 'corrallm',
    version: 1,
    nodes: [{ id: 'a', kind, label: 'Reviewer', position: { x: 0, y: 0 }, role }],
    links: [],
  });

describe('authored roles in graphs and files', () => {
  it('sets and clears an independent role, preserving its interior formatting and unrelated nodes', () => {
    const before = graph();
    const after = setRole(before, 'a', ' \n Release reviewer.\n\tCheck the rollout. \r\n');
    expect(after.nodes[0]?.data.role).toBe('Release reviewer.\n\tCheck the rollout.');
    expect(before.nodes[0]?.data.role).toBe('Review the release.\n\tKeep useful formatting.');
    expect(setRole(after, 'a', after.nodes[0]?.data.role)).toBe(after);
    expect(setRole(after, 'missing', 'unused')).toBe(after);
    const cleared = setRole(after, 'a', ' \t\r\n ');
    expect(cleared.nodes[0]?.data).not.toHaveProperty('role');
    expect(setRole(after, 'a', undefined).nodes[0]?.data).not.toHaveProperty('role');
  });

  it('round-trips the authored role and omits absent or blank roles from saved data', () => {
    const before = graph();
    expect(fromFile(toFile(before)).nodes[0]?.data.role).toBe(before.nodes[0]?.data.role);
    expect(toFile(fromFile(file(' \t\n ')))).not.toContain('"role"');
    expect(toFile(setRole(before, 'a', undefined))).not.toContain('"role"');
    expect(fromFile(file('  Reviewer.\n\tCheck carefully.  ')).nodes[0]?.data.role).toBe(
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
    expect(() => fromFile(file(role))).toThrow(/role/i);
  });

  it('validates in-memory authored roles before saving, and keeps roles off frames', () => {
    const before = graph();
    expect(() =>
      toFile({
        ...before,
        nodes: before.nodes.map((node) => ({
          ...node,
          data: { ...node.data, role: 'unsafe\0role' },
        })),
      }),
    ).toThrow(/role/i);
    expect(() => fromFile(file('Frame role', 'group'))).toThrow(/role/i);
    const frame: Graph = {
      nodes: [{ id: 'g', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Group' } }],
      edges: [],
    };
    expect(setRole(frame, 'g', 'unused')).toBe(frame);
  });

  it('discovers and fills role placeholders, clearing a role filled with whitespace', () => {
    const before = setRole(graph(), 'a', '{{specialty}}\n\tScope: {{scope}}');
    expect(placeholdersOf(before)).toEqual(['specialty', 'scope']);
    expect(
      fillTemplate(before, { specialty: 'Release reviewer', scope: 'the API' }).nodes[0]?.data.role,
    ).toBe('Release reviewer\n\tScope: the API');
    expect(
      fillTemplate(setRole(before, 'a', '{{specialty}}'), { specialty: ' \t\n ' }).nodes[0]?.data,
    ).not.toHaveProperty('role');
    expect(() => fillTemplate(before, { scope: 'bad\0scope' })).toThrow(/role/i);
  });

  it('preserves the role when switching CLI, importing and inserting a template with remapped IDs', () => {
    const before = graph();
    const template = withConnections(withAgents(before, { a: 'Codex' }), { a: 'app-server' });
    expect(template.nodes[0]?.data.role).toBe(before.nodes[0]?.data.role);
    expect(template.nodes[0]?.data.connection).toBe('app-server');
    const switched = setConnection(setAgent(before, 'a', 'Codex'), 'a', 'app-server');
    expect(switched.nodes[0]?.data.role).toBe(before.nodes[0]?.data.role);
    const imported = fromFile(toFile(switched));
    let count = 0;
    const inserted = insertGraph({ nodes: [], edges: [] }, imported, {
      group: 'group',
      name: 'Release',
      newId: () => `imported-${String(++count)}`,
    });
    const agent = inserted.nodes.find((node) => node.type === 'agent');
    expect(agent?.id).not.toBe('a');
    expect(agent?.data.role).toBe(before.nodes[0]?.data.role);
    expect(agent?.data.agent).toBe('Codex');
  });
});
