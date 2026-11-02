import { expect, it } from 'vitest';
import { TWO_MADE_UP } from '../test-made-up';
import { templateInfo } from '../templates';
import { compileTemplate } from './templates';
import { readTemplate } from './template-file';

const example = {
  name: 'Jobs',
  description: '',
  text: JSON.stringify({
    format: 'corrallm-template',
    version: 1,
    id: '6160af62-718e-4ae2-bb27-1a2ec6743130',
    nodes: [
      {
        id: 'a',
        kind: 'agent',
        label: 'Owner',
        position: { x: 0, y: 0 },
        queue: [
          { id: 's', job: 'shell', instruction: 'Run tests', expect: 'fails' },
          {
            id: 'if',
            if: { kind: 'failed' },
            then: [{ id: 'targeted', job: 'edit', target: 'b', instruction: 'Fix it' }],
          },
          {
            id: 'repeat',
            repeat: [{ id: 'r', job: 'shell', target: 'b' }],
            until: { kind: 'succeeded' },
            rounds: 2,
            otherwise: 'ask',
          },
        ],
      },
      { id: 'b', kind: 'agent', label: 'Recipient', position: { x: 400, y: 0 } },
    ],
    links: [],
  }),
};
const catalog = {
  ...TWO_MADE_UP,
  adapters: TWO_MADE_UP.adapters.map((a) =>
    a.id !== 'yak'
      ? a
      : {
          ...a,
          actions: [
            { name: 'patch-first', description: '', job: 'edit' as const },
            { name: 'patch-later', description: '', job: 'edit' as const },
            { name: 'run-yak', description: '', job: 'shell' as const },
          ],
        },
  ),
};
const roles = {
  a: { adapter: 'zed', connection: 'zed.free' },
  b: { adapter: 'yak', connection: 'yak.free' },
};
it('compiles each job for its recipient at every depth, using the first declared implementation', () => {
  const source = readTemplate(example.text);
  const before = JSON.stringify(source);
  const compiled = compileTemplate(source, roles, catalog);
  expect(compiled.nodes[0]?.data).toMatchObject({
    adapter: 'zed',
    connection: 'zed.free',
    queue: [
      { id: 's', action: 'shell', instruction: 'Run tests', expect: 'fails' },
      {
        id: 'if',
        then: [{ id: 'targeted', action: 'patch-first', target: 'b', instruction: 'Fix it' }],
      },
      { id: 'repeat', repeat: [{ id: 'r', action: 'run-yak', target: 'b' }] },
    ],
  });
  expect(JSON.stringify(compiled)).not.toContain('"job":');
  expect(JSON.stringify(source)).toBe(before);
});
it('reports only the jobs every role receives, including targeted nested steps', () => {
  expect(templateInfo(example).agents).toEqual([
    { id: 'a', name: 'Owner', jobs: ['shell'] },
    { id: 'b', name: 'Recipient', jobs: ['edit', 'shell'] },
  ]);
});
it('names the recipient role, step and job when it has no implementation', () => {
  expect(() => compileTemplate(readTemplate(example.text), roles, TWO_MADE_UP)).toThrow(
    /Recipient.*targeted.*edit/,
  );
});
it.each([
  { a: roles.a },
  { ...roles, b: { adapter: 'missing', connection: 'missing.c' } },
  { ...roles, b: { adapter: 'yak', connection: 'zed.acp' } },
  { ...roles, extra: roles.a },
])('requires exactly the template roles on known endpoints', (choice) => {
  expect(() => compileTemplate(readTemplate(example.text), choice, catalog)).toThrow();
});
