import { describe, expect, it } from 'vitest';
import { TEST_CATALOG } from '../test-model';
import { readTemplate } from './template-file';
import { fromFile } from './file';

const file = (
  queue: unknown[] = [{ id: 's', job: 'shell', instruction: 'Run the tests', expect: 'fails' }],
) => ({
  format: 'corrallm-template',
  version: 1,
  id: '6160af62-718e-4ae2-bb27-1a2ec6743130',
  nodes: [{ id: 'a', kind: 'agent', label: 'A', position: { x: 0, y: 0 }, queue }],
  links: [],
});
it('reads a template with jobs and keeps it separate from a canvas', () => {
  const given = file();
  expect(readTemplate(JSON.stringify(given)).nodes[0]).toMatchObject({
    type: 'agent',
    data: { queue: given.nodes[0]?.queue },
  });
  expect(() => fromFile(JSON.stringify(given), TEST_CATALOG)).toThrow(/canvas/i);
  expect(() => readTemplate(JSON.stringify({ ...given, format: 'corrallm', version: 3 }))).toThrow(
    /template/i,
  );
});
it.each(['adapter', 'connection', 'settings', 'fallback', 'handoff'])(
  'refuses a template that pins %s, saying where',
  (field) => {
    const given = file();
    Object.assign(given.nodes[0] ?? {}, { [field]: {} });
    expect(() => readTemplate(JSON.stringify(given))).toThrow(new RegExp('nodes\\[0\\].' + field));
  },
);
it.each(['top', 'if', 'repeat'])('refuses native actions at %s depth', (depth) => {
  const step = { id: 's', job: 'shell', action: 'native' };
  const item =
    depth === 'if'
      ? { id: 'if', if: { kind: 'failed' }, then: [step] }
      : depth === 'repeat'
        ? {
            id: 'repeat',
            repeat: [step],
            until: { kind: 'succeeded' },
            rounds: 2,
            otherwise: 'ask',
          }
        : step;
  expect(() => readTemplate(JSON.stringify(file([item])))).toThrow(/queue.*action/);
  const canvas = { ...file([item]), format: 'corrallm', version: 3 };
  expect(() => fromFile(JSON.stringify(canvas), TEST_CATALOG)).toThrow(/queue.*job/);
});
describe('template validation', () => {
  it('reports unknown jobs and duplicate queue ids at their location', () => {
    expect(() => readTemplate(JSON.stringify(file([{ id: 's', job: 'invented' }])))).toThrow(
      /queue.*job/,
    );
    expect(() =>
      readTemplate(
        JSON.stringify(
          file([
            { id: 's', job: 'shell' },
            { id: 's', message: 'hi' },
          ]),
        ),
      ),
    ).toThrow(/queue.*twice/);
  });
  it('validates the same structure and text bounds as a canvas', () => {
    const given = file();
    Object.assign(given.nodes[0] ?? {}, { parent: 'missing' });
    expect(() => readTemplate(JSON.stringify(given))).toThrow(/parent.*missing/);
  });
});
