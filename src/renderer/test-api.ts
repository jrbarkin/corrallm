import { expect } from 'vitest';

import type { OpResult } from '../shared/api/errors';
import { GUI_OPS } from '../shared/api/surface';
import type { GuiOp } from '../shared/api/surface';
import { topicKey } from '../shared/api/topics';
import type { Change, TopicKey, TopicSnapshot, TopicStates } from '../shared/api/topics';
import { guiFunction } from '../shared/gui-link';
import type { GuiApi, GuiBridge } from '../shared/gui-link';
import { fromBridge } from './api/bridge';
import { createClient } from './api/client';
import { TopicMirror, topics as windowTopics } from './api/topics';

export interface RecordedOp {
  op: GuiOp;
  args: unknown;
}
type FedChange = Change extends infer C
  ? C extends Change
    ? Omit<C, 'epoch' | 'seq' | 'at' | 'by'>
    : never
  : never;

/** A renderer's core: calls are recorded; tests decide the results and feed its pushed state. */
export function fakeCore() {
  const operations: RecordedOp[] = [];
  const subscriptions = new Set<TopicKey>();
  const snapshots = new Map<TopicKey, TopicSnapshot>();
  const replies = new Map<
    GuiOp,
    OpResult<unknown> | ((args: unknown) => Promise<OpResult<unknown>>)
  >();
  const changes = new Set<Parameters<GuiApi['topicsOnChange']>[0]>();
  const epochs = new Set<Parameters<GuiApi['topicsOnEpoch']>[0]>();
  let epoch = 'test-core';
  let seq = 0;
  let restore: (() => void) | undefined;
  const raw = {
    ...Object.fromEntries(
      GUI_OPS.map((op) => [
        guiFunction(op),
        async (args: unknown) => {
          if (op === 'topics.subscribe' || op === 'topics.unsubscribe') {
            const topic = topicKey(args as Parameters<GuiApi['topicsSubscribe']>[0]);
            if (op === 'topics.unsubscribe') {
              subscriptions.delete(topic);
              return { ok: true, value: {} };
            }
            subscriptions.add(topic);
            const snapshot = snapshots.get(topic);
            return snapshot
              ? { ok: true, value: snapshot }
              : {
                  ok: false,
                  error: { code: 'not-found', sentence: `No test snapshot for ${topic}.` },
                };
          }
          operations.push({ op, args });
          const reply = replies.get(op) ?? { ok: true, value: {} };
          return typeof reply === 'function' ? reply(args) : reply;
        },
      ]),
    ),
    topicsOnChange: (listener: Parameters<GuiApi['topicsOnChange']>[0]) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    topicsOnEpoch: (listener: Parameters<GuiApi['topicsOnEpoch']>[0]) => {
      epochs.add(listener);
      listener(epoch);
      return () => {
        epochs.delete(listener);
      };
    },
    terminalOnEvent: () => () => undefined,
  } as unknown as GuiBridge;
  const source = fromBridge(() => raw);
  const topics = new TopicMirror(source);
  const api = createClient(source, topics);
  return {
    api,
    topics,
    operations,
    subscriptions,
    respond(op: GuiOp, value: unknown): void {
      replies.set(op, { ok: true, value });
    },
    reply(
      op: GuiOp,
      reply: OpResult<unknown> | ((args: unknown) => Promise<OpResult<unknown>>),
    ): void {
      replies.set(op, reply);
    },
    state<K extends TopicKey>(topic: K): (TopicSnapshot & { state: TopicStates[K] }) | undefined {
      return snapshots.get(topic) as (TopicSnapshot & { state: TopicStates[K] }) | undefined;
    },
    snapshot<K extends TopicKey>(topic: K, state: TopicStates[K], rev = 0): void {
      snapshots.set(topic, { epoch, rev, state });
    },
    change(fed: FedChange): void {
      const state =
        'replace' in fed ? fed.replace : { ...snapshots.get(fed.topic)?.state, ...fed.set };
      if ('remove' in fed) for (const key of fed.remove ?? []) Reflect.deleteProperty(state, key);
      snapshots.set(fed.topic, { epoch, rev: fed.rev, state });
      if (!subscriptions.has(fed.topic)) return;
      const change = { ...fed, epoch, seq: ++seq, at: seq, by: 'you' } as Change;
      for (const listener of changes) listener([change]);
    },
    epoch(next: string): void {
      if (next === epoch) return;
      epoch = next;
      subscriptions.clear();
      for (const [topic, snapshot] of snapshots) snapshots.set(topic, { ...snapshot, epoch });
      for (const listener of epochs) listener(epoch);
    },
    install(): () => void {
      restore?.();
      const previous = Object.getOwnPropertyDescriptor(window, 'api');
      Object.defineProperty(window, 'api', { value: raw, configurable: true });
      restore = () => {
        windowTopics.dispose();
        if (previous) Object.defineProperty(window, 'api', previous);
        else Reflect.deleteProperty(window, 'api');
        restore = undefined;
      };
      return restore;
    },
    dispose(): void {
      topics.dispose();
      restore?.();
    },
  };
}

/** A gesture has exactly one intent, with its explicit arguments (B9 Design §11, T6). */
export function expectOneOp(
  core: Pick<ReturnType<typeof fakeCore>, 'operations'>,
  op: GuiOp,
  args: unknown,
): void {
  expect(core.operations).toEqual([{ op, args }]);
}
