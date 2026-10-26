import { describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../../shared/canvas';
import type { AgentNode } from '../../../../shared/model/canvas';
import { isOpen } from '../../../../shared/model/session';
import type { SessionEvent } from '../../../../shared/session';
import { needsOf } from '../../../../shared/model/needs-selectors';
import { fakeBackend } from '../test-backend';
import { TEST_ENGINE } from '../test-engine';
import { SessionStore } from './mailbox';

const agents = ['a', 'b', 'c'];
const connection = 'claude-code.sdk';
const nodes: AgentNode[] = agents.map((id) => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id },
}));

describe('the sessions’ open prompt index', () => {
  it('equals the transcript scan after seeded event, answer and lifecycle sequences', async () => {
    const { backend, emit } = fakeBackend();
    backend.rewind.mockResolvedValue({ conversation: true });
    const store = new SessionStore(TEST_ENGINE, backend);
    let seed = 0x54a;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const check = () => {
      for (const session of Object.values(store.snapshot())) {
        const scan = session.entries.filter(isOpen);
        expect(session.prompts).toEqual(scan);
        scan.forEach((prompt, index) => {
          expect(session.prompts?.[index]).toBe(prompt);
        });
      }
    };
    const stop = store.subscribe(check);
    const sync = async () => {
      store.sync(agents.map((id) => ({ id, connection })));
      await Promise.all(agents.map((id) => store.ready(id)));
    };
    const kinds = new Set<number>();
    try {
      await sync();
      for (let step = 0; step < 800; step++) {
        const agent = pick(agents);
        const prompts = store.of(agent).entries.filter(isOpen);
        const prompt = prompts.length === 0 ? 'missing' : pick(prompts).id;
        const id = `entry-${String(step)}`;
        const action = Math.floor(random() * 23);
        kinds.add(action);
        const say = (...events: SessionEvent[]) => {
          emit(agent, connection, ...events);
        };
        switch (action) {
          case 0:
            say({ type: 'permission', id, tool: 'Read', summary: id, always: null });
            break;
          case 1:
            say({
              type: 'question',
              id,
              questions: [
                { header: 'One', text: 'Which?', options: [], multiple: false },
                { header: 'Two', text: 'Why?', options: [], multiple: false },
              ],
            });
            break;
          case 2:
            say({ type: 'plan', id, plan: id });
            break;
          case 3:
            say({ type: 'elicitation', id, server: 'test', message: id });
            break;
          case 4:
            store.answer(agent, prompt, 'once');
            break;
          case 5:
            store.answerQuestion(agent, prompt, Math.floor(random() * 2), 'Answer');
            break;
          case 6:
            store.answerPlan(agent, prompt, { approve: false, feedback: 'Try again' });
            break;
          case 7:
            store.answerElicitation(agent, prompt, 'accept');
            break;
          case 8:
            say({ type: 'withdrawn', id: prompt });
            break;
          case 9:
            say(
              { type: 'text', id, text: id },
              { type: 'thinking', id: `${id}/thought`, text: id },
            );
            break;
          case 10:
            say(
              { type: 'tool', id, tool: 'Read', summary: id, status: 'running' },
              { type: 'tool', id, tool: 'Read', summary: id, status: 'done' },
            );
            break;
          case 11:
            say({
              type: 'history',
              events: [
                { type: 'user', id: `${id}/user`, text: id },
                {
                  type: 'permission',
                  id: `${id}/permission`,
                  tool: 'Read',
                  summary: id,
                  always: null,
                },
              ],
            });
            break;
          case 12:
            say(
              { type: 'user', id, text: id },
              {
                type: 'end',
                messages: [id],
                seconds: 1,
                result: { status: 'completed', reason: 'completed' },
              },
            );
            break;
          case 13:
            say({ type: 'closed' });
            await store.ready(agent);
            break;
          case 14:
            await store.resume(agent, id);
            break;
          case 15:
            await store.rewind(agent, id, 'conversation');
            break;
          case 16: {
            const saved = store.serializeSubmissions();
            store.reset();
            store.restoreSubmissions(saved);
            await sync();
            break;
          }
          case 17:
            say({ type: 'cleared', id });
            break;
          case 18:
            await store.fresh(agent);
            break;
          case 19:
            say({ type: 'permission', id: prompt, tool: 'Read', summary: id, always: null });
            break;
          case 20:
            say({ type: 'tool', id: prompt, tool: 'Read', summary: id, status: 'done' });
            break;
          case 21:
            store.restoreSubmissions(store.serializeSubmissions());
            break;
          case 22:
            await store.restart(agent);
            break;
        }
        await Promise.resolve();
        await Promise.resolve();
        check();
      }
      expect(kinds.size).toBe(23);
      store.sync([]);
      expect(store.snapshot()).toEqual({});
    } finally {
      stop();
      store.reset();
    }
  });

  it('reads indexed prompts without scanning closed transcript entries on each needs pass', async () => {
    const { backend, emit } = fakeBackend();
    const store = new SessionStore(TEST_ENGINE, backend);
    store.sync([{ id: 'a', connection }]);
    await store.ready('a');
    emit(
      'a',
      connection,
      {
        type: 'history',
        events: Array.from({ length: 2000 }, (_, i) => ({
          type: 'text',
          id: String(i),
          text: 'Past output',
        })),
      },
      { type: 'permission', id: 'permission', tool: 'Read', summary: 'notes', always: null },
    );
    const filter = vi.spyOn(store.of('a').entries, 'filter');
    const input = {
      canvas: 'canvas' as CanvasId,
      nodes,
      sessions: store.snapshot(),
      catalog: TEST_ENGINE,
      run: { running: false, agents: {} },
    };
    try {
      expect(needsOf(input)).toHaveLength(1);
      expect(needsOf(input)).toHaveLength(1);
      expect(filter).not.toHaveBeenCalled();
    } finally {
      filter.mockRestore();
      store.reset();
    }
  });
});
