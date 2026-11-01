import { expect, it, vi } from 'vitest';
import type { HostEvent } from './connector';
import { FakeConnector } from './fake';

it('reports context before a fake turn ends', async () => {
  const events: HostEvent[] = [];
  const session = await new FakeConnector().start(
    {
      agentId: 'a',
      cwd: '/unused',
      env: {},
      model: null,
      mode: 'acceptEdits',
      resume: null,
    },
    {
      emit: (event) => {
        events.push(event);
      },
      remember: vi.fn(),
    },
  );
  try {
    await session.send({ id: 'message', text: 'Hello' });
    await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
    const beforeEnd = events.slice(
      0,
      events.findIndex((event) => event.type === 'end'),
    );
    expect(beforeEnd.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
      usage: { context: { used: 1000, window: 200000, compactAt: 167000 } },
    });
  } finally {
    await session.close();
  }
});
