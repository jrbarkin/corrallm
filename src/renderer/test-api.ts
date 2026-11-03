import { expect } from 'vitest';

import type { MirrorStates, MirrorSnapshot, MirrorTopicKey } from './api/topic-wire';
import { runtimePatch, runtimeTopic } from './api/topic-wire';
import type { RuntimeChange } from '../shared/api/topics';
import type { OpResult } from '../shared/api/errors';
import { GUI_OPS, SURFACE } from '../shared/api/surface';
import type { GuiOp } from '../shared/api/surface';
import { topicKey } from '../shared/api/topics';
import type { Change, TopicKey, TopicStates, RuntimeTopicKey } from '../shared/api/topics';
import { consentIn } from '../shared/adapter';
import { guiFunction } from '../shared/gui-link';
import type { GuiApi, GuiBridge } from '../shared/gui-link';
import { fromBridge } from './api/bridge';
import { createClient } from './api/client';
import { TopicMirror, topics as windowTopics } from './api/topics';
import { catalog } from './catalog';

export interface RecordedOp {
  op: GuiOp;
  args: unknown;
}
type FedChange = Change | RuntimeChange extends infer C
  ? C extends Change | RuntimeChange
    ? Omit<C, 'epoch' | 'seq' | 'at' | 'by'>
    : never
  : never;

/**
 * A renderer's core: calls are recorded, a gesture's intents (`operations`: every write) apart from
 * what a view reads as it shows something (`reads`: a settings menu's options, a panel's list), which
 * is no gesture; tests decide the results and feed its pushed state.
 */
export function fakeCore() {
  const operations: RecordedOp[] = [];
  const reads: RecordedOp[] = [];
  const subscriptions = new Set<TopicKey | RuntimeTopicKey>();
  const snapshots = new Map<MirrorTopicKey, MirrorSnapshot>();
  const observers = new Set<(topic: MirrorTopicKey) => void>();
  const replies = new Map<
    GuiOp,
    OpResult<unknown> | ((args: unknown) => Promise<OpResult<unknown>>)
  >();
  const changes = new Set<Parameters<GuiApi['topicsOnChange']>[0]>();
  const epochs = new Set<Parameters<GuiApi['topicsOnEpoch']>[0]>();
  const shows = new Set<Parameters<GuiApi['windowOnShow']>[0]>();
  let epoch = 'test-core';
  let seq = 0;
  snapshots.set('settings', {
    epoch,
    rev: 0,
    // Your projection (B22a C2): notifications on, nothing attempted, no site remembered.
    state: {
      defaultAdapter: null,
      consents: {},
      api: { state: 'stopped', port: null },
      notifications: { enabled: true, lastDelivery: null },
      links: { state: 'ready', sites: [], builtIn: ['https://github.com'] },
    },
  });
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
            for (const observe of observers) observe(topic);
            const snapshot = snapshots.get(topic);
            return snapshot
              ? { ok: true, value: snapshot }
              : {
                  ok: false,
                  error: { code: 'not-found', sentence: `No test snapshot for ${topic}.` },
                };
          }
          (SURFACE[op].kind === 'read' ? reads : operations).push({ op, args });
          if (!replies.has(op) && op === 'agents') return { ok: true, value: { agents: [] } };
          if (!replies.has(op) && (op === 'settings.get' || op === 'settings.set')) {
            const previous = core.state('settings');
            if (!previous) throw new Error('No settings fixture');
            if (op === 'settings.get') return { ok: true, value: previous.state };
            const { state, value } = settingsSet(
              previous.state,
              args as NonNullable<Parameters<GuiApi['settingsSet']>[0]>,
            );
            if (state === previous.state) return { ok: true, value };
            const rev = previous.rev + 1;
            core.change({ topic: 'settings', rev, replace: state });
            return { ok: true, value: { ...value, revs: { settings: rev } } };
          }
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
    windowOnShow: (listener: Parameters<GuiApi['windowOnShow']>[0]) => {
      shows.add(listener);
      return () => {
        shows.delete(listener);
      };
    },
    terminalOnEvent: () => () => undefined,
  } as unknown as GuiBridge;
  const source = fromBridge(() => raw);
  const topics = new TopicMirror(source);
  const api = createClient(source, topics);
  const core = {
    api,
    show(target: Parameters<Parameters<GuiApi['windowOnShow']>[0]>[0]): void {
      for (const listener of shows) listener(target);
    },
    topics,
    operations,
    reads,
    subscriptions,
    observeTopics(observe: (topic: MirrorTopicKey) => void): () => void {
      observers.add(observe);
      return () => {
        observers.delete(observe);
      };
    },
    respond(op: GuiOp, value: unknown): void {
      replies.set(op, { ok: true, value });
    },
    reply(
      op: GuiOp,
      reply: OpResult<unknown> | ((args: unknown) => Promise<OpResult<unknown>>),
    ): void {
      replies.set(op, reply);
    },
    state<K extends MirrorTopicKey>(
      topic: K,
    ): (MirrorSnapshot & { state: MirrorStates[K] }) | undefined {
      return snapshots.get(topic) as (MirrorSnapshot & { state: MirrorStates[K] }) | undefined;
    },
    snapshot<K extends MirrorTopicKey>(topic: K, state: MirrorStates[K], rev = 0): void {
      snapshots.set(topic, { epoch, rev, state });
    },
    change(fed: FedChange): void {
      const previous = snapshots.get(fed.topic);
      if (!('replace' in fed) && runtimeTopic(fed.topic) && !previous)
        throw new Error('No runtime fixture snapshot');
      const state =
        'replace' in fed
          ? fed.replace
          : runtimeTopic(fed.topic)
            ? runtimePatch(previous?.state as never, fed as RuntimeChange)
            : { ...snapshots.get(fed.topic)?.state, ...('set' in fed ? fed.set : {}) };
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
  return core;
}

type SettingsState = TopicStates['settings'];

/**
 * settings.set as the core answers it (B12 C2, B22a C1), over the fake's settings: the state it
 * leaves (the same object when nothing changed, so no revision) and the result. A declared consent
 * is taken back even with nothing kept, as a live session may hold it; an undeclared one, or a site,
 * only while kept.
 */
function settingsSet(
  state: SettingsState,
  intent: NonNullable<Parameters<GuiApi['settingsSet']>[0]>,
): { state: SettingsState; value: object } {
  if (intent.notifications !== undefined) {
    const { enabled } = intent.notifications;
    const value = { notifications: { enabled } };
    if ((state.notifications?.enabled ?? true) === enabled) return { state, value };
    const lastDelivery = state.notifications?.lastDelivery ?? null;
    return { state: { ...state, notifications: { enabled, lastDelivery } }, value };
  }
  if (intent.consent !== undefined) {
    const target = intent.consent;
    if (target.kind === 'site') {
      const links = state.links;
      const kept = links?.state === 'ready' && links.sites.includes(target.origin);
      const value = { consent: { target, changed: kept } };
      if (!kept) return { state, value };
      const sites = links.sites.filter((site) => site !== target.origin);
      return { state: { ...state, links: { ...links, sites } }, value };
    }
    const kept = state.consents[target.adapter]?.[target.key] === true;
    const declared = consentIn(catalog(), target.adapter, target.key) !== undefined;
    const value = { consent: { target, changed: kept || declared } };
    if (!kept) return { state, value };
    const rest = Object.fromEntries(
      Object.entries(state.consents[target.adapter] ?? {}).filter(([key]) => key !== target.key),
    );
    const others = Object.fromEntries(
      Object.entries(state.consents).filter(([adapter]) => adapter !== target.adapter),
    );
    const consents =
      Object.keys(rest).length === 0 ? others : { ...state.consents, [target.adapter]: rest };
    return { state: { ...state, consents }, value };
  }
  const defaultAdapter = intent.defaultAdapter ?? null;
  const value = { defaultAdapter };
  return state.defaultAdapter === defaultAdapter
    ? { state, value }
    : { state: { ...state, defaultAdapter }, value };
}

/** A gesture has exactly one intent, with its explicit arguments (B9 Design §11, T6). */
export function expectOneOp(
  core: Pick<ReturnType<typeof fakeCore>, 'operations'>,
  op: GuiOp,
  args: unknown,
): void {
  expect(core.operations).toEqual([{ op, args }]);
}

/** A view's read (a panel's list, a menu's options) is one read, with its explicit arguments. */
export function expectOneRead(
  core: Pick<ReturnType<typeof fakeCore>, 'reads'>,
  op: GuiOp,
  args: unknown,
): void {
  expect(core.reads).toEqual([{ op, args }]);
}
