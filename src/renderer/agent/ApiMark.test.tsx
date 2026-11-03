import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import type { AgentNode } from '../../shared/model/canvas';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { fakeCore } from '../test-api';
import { ApiMark, FallbackProvider } from './Fallback';

const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});
const node: AgentNode = {
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Writer' },
};
function show(api?: boolean) {
  const core = fakeCore();
  cores.push(core);
  const canvas = newCanvasId();
  const summary = {
    ...sessionView(AgentId.parse('a'), 'zed.acp', NEW_SESSION).summary,
    api: api === true,
  };
  core.snapshot(`sessions:${canvas}`, { agents: { [AgentId.parse('a')]: summary } });
  render(
    <FallbackProvider canvas={canvas} client={core.api} mirror={core.topics} nodes={[node]}>
      <ApiMark agent="a" />
    </FallbackProvider>,
  );
  return { core, canvas, summary };
}

it('renders under the default fake core without an unhandled read failure', async () => {
  const { core, canvas } = show();
  await waitFor(() => {
    expect(core.topics.snapshot(`sessions:${canvas}`)).toBeDefined();
  });
  expect(core.reads).toEqual([]);
  expect(await core.api.agents({ canvas })).toEqual({ agents: [] });
  expect(screen.queryByLabelText('Uses corrallm’s tools')).toBeNull();
});

it('marks an agent whose session has listed corrallm’s tools, without another read or operation', async () => {
  const { core } = show(true);
  expect(await screen.findByLabelText('Uses corrallm’s tools')).toBeTruthy();
  expect(core.reads).toEqual([]);
  expect(core.operations).toEqual([]);
});

it('shows no mark for an agent whose session has not listed them', async () => {
  const { core, canvas } = show(false);
  await waitFor(() => {
    expect(core.topics.snapshot(`sessions:${canvas}`)).toBeDefined();
  });
  expect(screen.queryByLabelText('Uses corrallm’s tools')).toBeNull();
});

it.each(['failed', 'malformed'])(
  'uses the summary when an agents read would be %s',
  async (kind) => {
    const { core } = show(true);
    core.reply(
      'agents',
      kind === 'failed'
        ? { ok: false, error: { code: 'unavailable', sentence: 'The core is closing.' } }
        : { ok: true, value: {} },
    );
    expect(await screen.findByLabelText('Uses corrallm’s tools')).toBeTruthy();
    expect(core.reads).toEqual([]);
  },
);

it('updates listing and revocation from the summary without a status change', async () => {
  const { core, canvas, summary } = show(false);
  await waitFor(() => {
    expect(core.topics.snapshot(`sessions:${canvas}`)).toBeDefined();
  });
  act(() => {
    core.change({
      topic: `sessions:${canvas}`,
      rev: 1,
      agents: { set: { [AgentId.parse('a')]: { ...summary, api: true } } },
    });
  });
  expect(await screen.findByLabelText('Uses corrallm’s tools')).toBeTruthy();
  act(() => {
    core.change({
      topic: `sessions:${canvas}`,
      rev: 2,
      agents: { set: { [AgentId.parse('a')]: { ...summary, api: false } } },
    });
  });
  expect(screen.queryByLabelText('Uses corrallm’s tools')).toBeNull();
  expect(core.reads).toEqual([]);
});
