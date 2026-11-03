import { expect, it, vi } from 'vitest';

import type { HostEvent, SessionSpec } from './connector';
import type { SessionMode } from '../../shared/session';
import { FakeConnector, type FakeProfile } from './fake';

const spec: SessionSpec<SessionMode> = {
  agentId: 'fixture',
  cwd: '/unused',
  env: {},
  model: null,
  mode: null,
  resume: null,
};
const profile: FakeProfile = {
  mode: 'auto',
  models: [{ value: 'swift', label: 'Swift', efforts: [{ value: 'deep', label: 'Deep' }] }],
  effort: true,
  askingModes: ['auto'],
  features: { role: 'none' as const, resume: false, list: false },
  plan: () => ({
    kind: 'plan',
    answerIn: 'api',
    title: 'Next steps',
    plan: 'Build it',
    choices: [{ value: 'go', label: 'Build', hint: 'allow_once', effects: {} }],
  }),
};

it('reports the supplied model, effort, mode and effective feature fixture without an adapter id', async () => {
  const emit = vi.fn();
  const session = await new FakeConnector({ profile }).start(
    { ...spec, effort: 'deep' },
    { emit, remember: vi.fn() },
  );
  try {
    expect(emit).toHaveBeenCalledWith({
      type: 'started',
      model: 'swift',
      mode: 'auto',
      models: profile.models,
      effort: 'deep',
      ...profile.features,
    });
  } finally {
    await session.close();
  }
});

it('uses the supplied asking modes after a live mode change', async () => {
  const events: HostEvent[] = [];
  const session = await new FakeConnector({ profile, step: () => Promise.resolve() }).start(
    { ...spec, mode: 'acceptEdits' },
    { emit: (event) => events.push(event), remember: vi.fn() },
  );
  try {
    await session.send({ id: 'first', text: 'Hello' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'end')).toBe(true);
    });
    expect(events.some((event) => event.type === 'prompt')).toBe(false);
    await session.setMode('auto');
    await session.send({ id: 'second', text: 'Again' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'prompt')).toBe(true);
    });
  } finally {
    await session.close();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'end')).toHaveLength(2);
    });
  }
});

it('applies a supplied plan choice’s mode effect instead of interpreting its value as a native mode', async () => {
  const events: HostEvent[] = [];
  const session = await new FakeConnector({
    profile: {
      ...profile,
      plan: () => ({
        kind: 'plan' as const,
        answerIn: 'api' as const,
        title: 'Next steps',
        plan: 'Build it',
        choices: [
          {
            value: 'go',
            label: 'Build',
            hint: 'allow_once' as const,
            effects: { mode: 'full-access' },
          },
          { value: 'revise', label: 'Revise', hint: 'reject_once' as const, effects: {} },
        ],
      }),
    },
    step: () => Promise.resolve(),
  }).start(spec, { emit: (event) => events.push(event), remember: vi.fn() });
  try {
    await session.send({ id: 'plan', text: '/plan' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'prompt')).toBe(true);
    });
    const raised = events.find((event) => event.type === 'prompt');
    expect(raised).toMatchObject({ prompt: { title: 'Next steps' } });
    if (raised?.type !== 'prompt') throw new Error('The plan was not raised');
    session.prompts?.answer(raised.key, { kind: 'choice', value: 'go' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'end')).toBe(true);
    });
    expect(events).toContainEqual({ type: 'mode', mode: 'full-access' });
  } finally {
    await session.close();
  }
});
