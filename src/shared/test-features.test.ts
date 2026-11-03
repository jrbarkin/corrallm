import { expect, it } from 'vitest';

import { connectionIn } from './adapter';
import { FEATURE_CATALOG, featureGeneration, featureStarted } from './test-features';

it('offers unfamiliar feature combinations including a transcript continuation and restricted panels', () => {
  const rich = connectionIn(FEATURE_CATALOG, 'zed.acp');
  expect(rich?.connection).toMatchObject({
    view: 'transcript',
    continueIn: { connection: 'zed.free', shell: false, mcpSignIn: false },
    panels: {
      resume: true,
      mcp: { changes: ['reconnect'] },
      rewind: { restores: ['conversation'] },
    },
    images: { types: ['image/png'], maxBytes: 16, max: 1 },
  });
  expect(connectionIn(FEATURE_CATALOG, 'zed.free')?.connection.continueIn).toEqual({
    connection: 'zed.terminal',
    commands: [],
    shell: true,
    mcpSignIn: true,
  });
  expect(connectionIn(FEATURE_CATALOG, 'zed.terminal')?.connection.keys?.shiftEnter).toBe(
    '\x1b[13;2u',
  );
  expect(connectionIn(FEATURE_CATALOG, 'yak.terminal')?.connection.keys?.shiftEnter).toBeNull();
});

it.each([
  ['zed.acp', 'append', true, true],
  ['elm.free', 'append-new', true, false],
  ['yak.free', 'none', false, false],
] as const)(
  'prepares a started report and ready-generation data for %s',
  (connection, role, resume, list) => {
    const report = featureStarted(connection);
    const state = featureGeneration(connection, 42);
    expect(report).toMatchObject({ type: 'started', role, resume, list });
    expect(state).toMatchObject({ generation: 42, features: { role, resume, list } });
    expect(featureGeneration(connection, 43, false)).toEqual({ generation: 43, features: null });
  },
);

it('returns detached feature fixtures so narrowing one generation cannot change the next', () => {
  const first = featureGeneration('zed.acp', 1);
  first.features?.panels.mcp?.changes.splice(0);
  if (first.features) first.features.live.effort = false;
  expect(featureGeneration('zed.acp', 2).features).toMatchObject({
    panels: { mcp: { changes: ['reconnect'] } },
    live: { effort: true },
  });
});
