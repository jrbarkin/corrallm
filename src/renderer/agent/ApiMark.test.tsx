import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import type { AgentNode } from '../../shared/model/canvas';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { expectOneRead, fakeCore } from '../test-api';
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
const row = (api: boolean) => ({
  id: 'a',
  name: 'Writer',
  adapter: null,
  connection: null,
  state: 'idle',
  prompts: 0,
  linked: [],
  api,
  fallback: null,
  handoff: null,
});

function show(api: boolean) {
  const core = fakeCore();
  cores.push(core);
  const canvas = newCanvasId();
  const summary = sessionView(AgentId.parse('a'), 'zed.acp', NEW_SESSION).summary;
  core.snapshot(`sessions:${canvas}`, { agents: { [AgentId.parse('a')]: summary } });
  core.respond('agents', { agents: [row(api)] });
  render(
    <FallbackProvider canvas={canvas} client={core.api} mirror={core.topics} nodes={[node]}>
      <ApiMark agent="a" />
    </FallbackProvider>,
  );
  return { core, canvas, summary };
}

it('marks an agent whose session has listed corrallm’s tools, with one read and no operation', async () => {
  const { core, canvas } = show(true);
  expect(await screen.findByLabelText('Uses corrallm’s tools')).toBeTruthy();
  expectOneRead(core, 'agents', { canvas });
  expect(core.operations).toEqual([]);
});

it('shows no mark for an agent whose session has not listed them', async () => {
  const { core } = show(false);
  await waitFor(() => {
    expect(core.reads).toHaveLength(1);
  });
  expect(screen.queryByLabelText('Uses corrallm’s tools')).toBeNull();
});

it('reads again when the session’s status changes, since listing happens as it starts', async () => {
  const { core, canvas, summary } = show(false);
  await waitFor(() => {
    expect(core.reads).toHaveLength(1);
  });
  core.respond('agents', { agents: [row(true)] });
  act(() => {
    core.change({
      topic: `sessions:${canvas}`,
      rev: 1,
      agents: { set: { [AgentId.parse('a')]: { ...summary, status: 'working' } } },
    });
  });
  expect(await screen.findByLabelText('Uses corrallm’s tools')).toBeTruthy();
});
