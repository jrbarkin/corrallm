import { expect, it } from 'vitest';

import { Prompt } from '../../../../shared/model/prompts';
import type { OpenPromptEntry } from '../../../../shared/model/session';
import { SessionStore } from '../delivery/mailbox';
import { TEST_ENGINE } from '../test-engine';
import { fakeBackend } from '../test-backend';

function entry(n: number, agent = 'a'): OpenPromptEntry {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    kind: 'prompt',
    need: `prompt/${agent}/1/${id}`,
    name: 'Worker',
    prompt: Prompt.parse({
      id,
      agent,
      raised: n,
      kind: 'approval',
      title: `Prompt ${String(n)}`,
      answerIn: 'terminal',
      choices: [],
    }),
  };
}

function end(store: SessionStore, opened: OpenPromptEntry, agent = 'a') {
  const { id, kind, title, raised, answerIn } = opened.prompt;
  store.promptEntry(agent, {
    type: 'ended',
    id,
    prompt: { id, kind, title, raised, answerIn, agent },
    outcome: { type: 'withdrawn' },
  });
}

it('keeps the newest 100 ended prompts and every waiting prompt in place, without changing other entries', () => {
  const store = new SessionStore(TEST_ENGINE, fakeBackend().backend);
  try {
    const waiting = entry(1000);
    store.promptEntry('a', { type: 'raised', entry: waiting });
    const opened = Array.from({ length: 101 }, (_, n) => entry(n));
    for (const prompt of opened) {
      if (prompt === opened[50]) {
        store.notice('a', 'info', 'Keep this notice in place.');
        store.promptEntry('a', { type: 'raised', entry: entry(1001) });
      }
      store.promptEntry('a', { type: 'raised', entry: prompt });
      if (prompt !== opened.at(-1)) end(store, prompt);
    }
    const before = store.of('a').entries;
    const last = opened.at(-1);
    if (!last) throw new Error('No last prompt');
    end(store, last);
    const after = store.of('a').entries;
    expect(after.filter((one) => one.kind === 'prompt' && one.outcome !== undefined)).toHaveLength(
      100,
    );
    expect(after.map(({ id }) => id)).toEqual(
      before.filter(({ id }) => id !== opened[0]?.id).map(({ id }) => id),
    );
    for (const kept of after) {
      if (kept.id !== last.id) expect(kept).toBe(before.find(({ id }) => id === kept.id));
    }
    expect(after[0]).toBe(waiting);
    expect(after.filter((one) => one.kind === 'prompt' && one.outcome === undefined)).toHaveLength(
      2,
    );

    // A waiting entry is protected even when it precedes every retained ended entry. When it
    // later ends, it is the oldest ended entry by transcript position and can be dropped itself.
    end(store, waiting);
    expect(store.of('a').entries.map(({ id }) => id)).toEqual(after.slice(1).map(({ id }) => id));
  } finally {
    store.reset();
  }
});

it('bounds ended prompt history separately for each agent', () => {
  const store = new SessionStore(TEST_ENGINE, fakeBackend().backend);
  try {
    for (const agent of ['a', 'b']) {
      for (let n = 0; n < 101; n++) {
        const opened = entry(n, agent);
        store.promptEntry(agent, { type: 'raised', entry: opened });
        end(store, opened, agent);
      }
      expect(store.of(agent).entries.map(({ id }) => id)).toEqual(
        Array.from({ length: 100 }, (_, n) => entry(n + 1, agent).id),
      );
    }
    expect(store.of('a').entries).toHaveLength(100);
  } finally {
    store.reset();
  }
});
