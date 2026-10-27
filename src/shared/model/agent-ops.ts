import { adapterIn, isStartMode } from '../adapter';
import type { AdapterId, Catalog, ConnectionId } from '../adapter';
import { parseRole } from '../role';
import { mergeAgentSettings } from '../session';
import type { AgentSettingsChange } from '../session';
import type { AgentData, CanvasDocument } from './canvas';
import { isIf, isRepeat } from './queue';
import type { QueueItem } from './queue';
import type { Built } from './structure';
import { endpointOf, parseFallback, readFallback, sameFallback, sameStep } from './fallback';
import type { FallbackInput } from './fallback';

export interface AgentContext {
  catalog: Catalog;
  defaultAdapter: AdapterId;
}

/** Applies an agent data edit, preserving every untouched node and document array. */
export function editAgent(
  doc: CanvasDocument,
  agent: string,
  change: (data: AgentData) => AgentData,
): Built {
  const node = doc.nodes.find((node) => node.id === agent);
  if (node?.type !== 'agent') return { next: doc, result: {} };
  const data = change(node.data);
  return {
    next:
      data === node.data
        ? doc
        : { ...doc, nodes: doc.nodes.map((one) => (one === node ? { ...one, data } : one)) },
    result: {},
  };
}

/** The action doing the same catalog job, if both adapters declare one. */
export function equivalentAction(
  action: string,
  from: AdapterId,
  to: AdapterId,
  catalog: Catalog,
): string | undefined {
  if (from === to) return action;
  const job = adapterIn(catalog, from)?.actions.find((one) => one.name === action)?.job;
  return job === undefined
    ? undefined
    : adapterIn(catalog, to)?.actions.find((one) => one.job === job)?.name;
}

/** Steps keep their job across adapters; unknown actions stay for their author to change. */
export function translateActions(
  queue: readonly QueueItem[],
  from: AdapterId,
  to: AdapterId,
  catalog: Catalog,
): QueueItem[] {
  const target = adapterIn(catalog, to);
  const translate = <T extends QueueItem>(item: T): T => {
    if (!('action' in item) || target?.actions.some((action) => action.name === item.action))
      return item;
    const action = equivalentAction(item.action, from, to, catalog);
    return !action || action === item.action ? item : { ...item, action };
  };
  const next = queue.map((item): QueueItem => {
    if (isIf(item)) {
      const then = item.then.map(translate);
      return sameItems(item.then, then) ? item : { ...item, then };
    }
    if (isRepeat(item)) {
      const repeat = item.repeat.map(translate);
      return sameItems(item.repeat, repeat) ? item : { ...item, repeat };
    }
    return translate(item);
  });
  return sameItems(queue, next) ? (queue as QueueItem[]) : next;
}

/** Changes adapter, translating its steps and dropping incompatible connection and mode choices. */
export function setType(
  doc: CanvasDocument,
  { agent, adapter }: { agent: string; adapter: AdapterId },
  context: AgentContext,
): Built {
  return editAgent(doc, agent, (before) => {
    const chosen = withoutPosition(before);
    if (before.adapter === adapter) return chosen;
    const { connection, settings, ...data } = chosen;
    const descriptor = adapterIn(context.catalog, adapter);
    const kept =
      connection !== undefined && descriptor?.connections.some((one) => one.id === connection);
    const queue =
      data.queue &&
      translateActions(
        data.queue,
        data.adapter ?? context.defaultAdapter,
        adapter,
        context.catalog,
      );
    return {
      ...data,
      adapter,
      ...(queue ? { queue } : {}),
      ...(kept ? { connection } : {}),
      ...fitted(
        settings,
        adapter,
        kept ? connection : descriptor?.connections[0]?.id,
        context.catalog,
      ),
    };
  });
}

/** Selects one of the adapter's connections, fitting its saved mode to what that connection starts. */
export function setConnection(
  doc: CanvasDocument,
  { agent, connection }: { agent: string; connection: ConnectionId },
  context: AgentContext,
): Built {
  return editAgent(doc, agent, (before) => {
    const adapter = before.adapter ?? context.defaultAdapter;
    if (!adapterIn(context.catalog, adapter)?.connections.some((one) => one.id === connection))
      return before;
    const chosen = withoutPosition(before);
    if (before.connection === connection) return chosen;
    const { settings, ...data } = chosen;
    return { ...data, connection, ...fitted(settings, adapter, connection, context.catalog) };
  });
}

/** Your chain edit resolves connections now; only an existing corrallm position can be retained. */
export function setFallback(
  doc: CanvasDocument,
  { agent, fallback }: { agent: string; fallback: FallbackInput | null },
  context: AgentContext,
): Built {
  return editAgent(doc, agent, (before) => {
    if (fallback === null) {
      if (before.fallback === undefined) return before;
      const data = { ...before };
      delete data.fallback;
      return data;
    }
    const current = endpointOf(before, context.catalog, context.defaultAdapter);
    if (current === undefined)
      throw new TypeError('Choose the agent’s endpoint before its fallback');
    const parsed = parseFallback(fallback, context.catalog);
    const on = before.fallback?.on;
    const step = on === undefined ? -1 : parsed.to.findIndex((one) => sameStep(one, current));
    const next = readFallback(
      { ...parsed, ...(on !== undefined && step >= 0 ? { on: { ...on, step } } : {}) },
      context.catalog,
      current,
    );
    return sameFallback(before.fallback, next) ? before : { ...before, fallback: next };
  });
}

function withoutPosition(data: AgentData): AgentData {
  if (data.fallback?.on === undefined) return data;
  const fallback = { ...data.fallback };
  delete fallback.on;
  return { ...data, fallback };
}

/** Merges one adapter's settings; omitted fields stay and null unsets a field. */
export function setSettings(
  doc: CanvasDocument,
  { agent, adapter, change }: { agent: string; adapter: AdapterId; change: AgentSettingsChange },
): Built {
  return editAgent(doc, agent, (before) => {
    const settings = mergeAgentSettings(before.settings, adapter, change);
    if (sameSettings(before.settings, settings)) return before;
    const data = { ...before };
    delete data.settings;
    return settings === undefined ? data : { ...data, settings };
  });
}

/** Sets the authored role without changing settings, queue items or session choices. */
export function setRole(
  doc: CanvasDocument,
  { agent, role }: { agent: string; role: string | undefined },
): Built {
  return editAgent(doc, agent, (before) => {
    const parsed = parseRole(role);
    if (parsed === before.role) return before;
    const data = { ...before };
    if (parsed === undefined) delete data.role;
    else data.role = parsed;
    return data;
  });
}

function fitted(
  settings: AgentData['settings'],
  adapter: AdapterId,
  connection: ConnectionId | undefined,
  catalog: Catalog,
): Pick<AgentData, 'settings'> {
  if (settings === undefined) return {};
  const mode = Object.hasOwn(settings, adapter) ? settings[adapter]?.mode : undefined;
  const known = adapterIn(catalog, adapter);
  const runs = known?.connections.some((one) => one.id === connection) ? connection : undefined;
  if (mode === undefined || !known || isStartMode(catalog, adapter, runs, mode))
    return { settings };
  const kept = mergeAgentSettings(settings, adapter, { mode: null });
  return kept === undefined ? {} : { settings: kept };
}

function sameSettings(a: AgentData['settings'], b: AgentData['settings']): boolean {
  if (a === b) return true;
  const keys = Object.keys(a ?? {});
  return (
    keys.length === Object.keys(b ?? {}).length &&
    keys.every((key) => {
      const one = a?.[key];
      const two = b?.[key];
      return one?.model === two?.model && one?.effort === two?.effort && one?.mode === two?.mode;
    })
  );
}

function sameItems(a: readonly QueueItem[], b: readonly QueueItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
