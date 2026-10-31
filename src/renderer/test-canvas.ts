import type { Run } from '../shared/model/run';
import type { Session } from '../shared/model/session';
import type { MessageView } from '../shared/model/views';
import { canvasRuntime } from './test-canvas-runtime';
import { fakeSessions } from './test-sessions';
import type { SessionReplies } from './test-sessions';
import type { CanvasId } from '../shared/canvas';
import { newCanvasId } from '../shared/canvas';
import { OPS } from '../shared/api/registry';
import type { GuiOp } from '../shared/api/surface';
import type { CanvasDocument } from '../shared/model/canvas';
import { fromFile, toFile } from '../shared/model/file';
import { diffRows } from '../shared/model/rows';
import type { Entities, Entity, MetaEntity } from '../shared/model/state';
import * as S from '../shared/model/structure';
import * as Q from '../shared/model/queue-ops';
import * as A from '../shared/model/agent-ops';
import type { QueueChange, QueueEntry } from '../shared/model/queue';
import { arrange } from '../shared/model/layout';
import { insert } from '../shared/model/insert';
import { fillTemplate, withAgents, withConnections } from '../shared/model/templates';
import { exampleOf, EXAMPLES } from '../shared/examples';
import { templateInfo } from '../shared/templates';
import { catalog } from './catalog';
import { DEFAULT_AGENT } from './graph/agents';
import { fakeCore } from './test-api';
import { UsageStore } from './usage/store';
import type { UsageSource } from './usage/store';

/** A canvas's project folder, as the core says it. */
interface Project {
  name: string;
  path: string;
}

export type FakeCanvas = ReturnType<typeof fakeCanvas>;

/** An in-memory canvas core for editor gesture tests: real schemas and pure builds, pushed rows. */
export function fakeCanvas(
  initial: CanvasDocument,
  replies?: SessionReplies,
  usageSource?: UsageSource,
) {
  const core = fakeCore();
  const fallback = fakeSessions().replies;
  const usage = new UsageStore(usageSource);
  core.reply('catalog.installed', async () => ({
    ok: true,
    value: await (replies ?? fallback).installed(),
  }));
  core.reply('project.files', async (raw) => {
    const { query, agent } = OPS['project.files'].input.parse(raw);
    return { ok: true, value: { items: await (replies ?? fallback).files(query, agent) } };
  });
  core.respond('templates.list', {
    items: EXAMPLES.map((example) => templateInfo(example, catalog(), DEFAULT_AGENT)),
  });
  let runtime: ReturnType<typeof canvasRuntime> | undefined;
  const runtimes = new Map<CanvasId, ReturnType<typeof canvasRuntime>>();
  let document = initial;
  let rev = 1;
  let saved = toFile(initial);
  let entities: Entities = {};
  let rows = diffRows({}, initial).rows;
  const meta = {
    name: null as string | null,
    edited: false,
    project: null as Project | null,
  };
  const dispose = core.dispose.bind(core);
  core.dispose = () => {
    usage.dispose();
    for (const one of runtimes.values()) one.dispose();
    dispose();
  };
  const context = { newId: () => crypto.randomUUID(), defaultAdapter: DEFAULT_AGENT };
  const keep = (next: CanvasDocument) => {
    const prior = document;
    if (toFile(next) === toFile(prior)) return rev;
    const changed = diffRows(rows, next, prior);
    rows = changed.rows;
    document = next;
    runtime?.update(next);
    rev++;
    const set: Record<string, Entity> = Object.fromEntries(
      [...changed.changed, ...changed.renumbered]
        .filter((key) => changed.rows[key] !== undefined)
        .map((key) => [key, { ...changed.rows[key], rev, by: 'you' } as Entity]),
    );
    const remove = changed.changed.filter((key) => changed.rows[key] === undefined);
    set.meta = { ...meta, arrange: next.arrange, edited: toFile(next) !== saved, rev, by: 'you' };
    entities = { ...entities, ...set };
    for (const key of remove) Reflect.deleteProperty(entities, key);
    core.change({ topic: `canvas:${document.id}`, rev, set, remove });
    return rev;
  };
  const open = (next: CanvasDocument, creating = false) => {
    const prior = core.state(`canvas:${next.id}`);
    document = next;
    rev = prior ? prior.rev + 1 : 1;
    saved = creating ? '' : toFile(next);
    meta.edited = creating && next.nodes.length > 0;
    rows = diffRows({}, next).rows;
    entities = Object.fromEntries(
      Object.entries(rows).map(([key, row]) => [key, { ...row, rev, by: 'you' }]),
    ) as Entities;
    entities = { ...entities, meta: { arrange: next.arrange, ...meta, rev, by: 'you' } };
    if (prior) core.change({ topic: `canvas:${next.id}`, rev, replace: entities });
    else core.snapshot(`canvas:${next.id}`, entities, rev);
    core.respond('window.get', { canvas: next.id });
    if (!core.state(`run:${next.id}`))
      core.snapshot(`run:${next.id}`, { running: false, agents: {}, groups: {}, notices: [] });
    if (!core.state(`sessions:${next.id}`)) core.snapshot(`sessions:${next.id}`, { agents: {} });
    if (!core.state(`messages:${next.id}`))
      core.snapshot(`messages:${next.id}`, { items: {}, order: [], next: '' });
    if (!core.state(`needs:${next.id}`)) core.snapshot(`needs:${next.id}`, { items: [] });
    if (!core.state(`worktrees:${next.id}`))
      core.snapshot(`worktrees:${next.id}`, { items: [], into: null, kept: [] });
    runtime = runtimes.get(next.id);
    if (runtime) {
      runtime.activate();
      runtime.update(next);
    } else {
      runtime = canvasRuntime(core, next, replies, keep);
      runtimes.set(next.id, runtime);
    }
  };
  open(initial);
  core.snapshot('canvases', { items: [] });
  /** The canvas's meta changed (its name, folder, whether edited), as the core says it. */
  function view(next: Partial<typeof meta>) {
    if (next.edited === false) saved = toFile(document);
    Object.assign(meta, next);
    rev++;
    entities = { ...entities, meta: { ...meta, arrange: document.arrange, rev, by: 'you' } };
    core.change({
      topic: `canvas:${document.id}`,
      rev,
      set: { meta: entities.meta as MetaEntity },
    });
  }
  const create = (raw: unknown) => {
    const args = OPS['canvas.create'].input.parse(raw);
    const example = args.template === undefined ? undefined : exampleOf(args.template);
    if (args.template !== undefined && !example) throw new Error('No test template');
    const part = !example
      ? emptyCanvas()
      : withConnections(
          withAgents(
            fillTemplate(fromFile(example.text, catalog(), DEFAULT_AGENT), args.values ?? {}),
            args.agents ?? {},
            { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
          ),
          args.connections ?? {},
          { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
        );
    meta.name = null;
    meta.project = null;
    open({ ...part, id: newCanvasId() }, true);
    return Promise.resolve({
      ok: true as const,
      value: { canvas: document.id, revs: { [`canvas:${document.id}`]: rev } },
    });
  };
  core.reply('canvas.create', create);
  /**
   * The file and folder operations as the core answers them, its dialogs' picks set by the test:
   * each text canvas.save and canvas.saveAs saved, as the core keeps the document.
   */
  const files = {
    saved: [] as string[],
    /** The file the Save dialog picks: its name, or null (cancelled). */
    saveAs: 'team.corral' as string | null,
    /** What the Open dialog picks: a canvas file, a file that isn't one (refused), or null. */
    open: null as { document: CanvasDocument; name: string; project?: Project } | Error | null,
    /** What the folder dialog picks, in turn: a folder, or null (cancelled). */
    folders: [] as (Project | null)[],
  };
  const saveTo = (name: string) => {
    files.saved.push(toFile(document));
    meta.name = name;
    view({ edited: false });
    return Promise.resolve({ ok: true as const, value: { name, revs: {} } });
  };
  core.reply('canvas.save', () =>
    meta.name === null
      ? Promise.resolve({
          ok: false as const,
          error: { code: 'refused' as const, sentence: 'This canvas has no file yet.' },
        })
      : saveTo(meta.name),
  );
  core.reply('canvas.saveAs', () =>
    files.saveAs === null
      ? Promise.resolve({ ok: true as const, value: { name: null, revs: {} } })
      : saveTo(files.saveAs),
  );
  core.reply('canvas.open', () => {
    const picked = files.open;
    if (picked instanceof Error)
      return Promise.resolve({
        ok: false as const,
        error: { code: 'invalid' as const, sentence: picked.message },
      });
    if (picked === null) return Promise.resolve({ ok: true, value: { canvas: null, revs: {} } });
    meta.name = picked.name;
    meta.project = picked.project ?? null;
    open(picked.document);
    return Promise.resolve({ ok: true, value: { canvas: document.id, revs: {} } });
  });
  core.reply('project.choose', () => {
    const project = files.folders.shift() ?? null;
    if (project) view({ project });
    return Promise.resolve({ ok: true, value: { project, revs: {} } });
  });
  const ops: GuiOp[] = [
    'agent.setType',
    'agent.setConnection',
    'agent.setSettings',
    'agent.setRole',
    'queue.add',
    'queue.remove',
    'queue.move',
    'queue.update',
    'canvas.addAgent',
    'canvas.spawnAgent',
    'canvas.rename',
    'canvas.delete',
    'canvas.link',
    'canvas.unlink',
    'canvas.group',
    'canvas.ungroup',
    'canvas.addParent',
    'canvas.move',
    'canvas.setArrange',
    'canvas.insertTemplate',
  ];
  for (const op of ops)
    core.reply(op, (raw) => {
      let built: S.Built<unknown>;
      switch (op) {
        case 'agent.setType': {
          const args = OPS[op].input.parse(raw);
          const next = A.setType(document, args, {
            catalog: catalog(),
            defaultAdapter: DEFAULT_AGENT,
          });
          built =
            args.connection === undefined
              ? next
              : A.setConnection(
                  next.next,
                  { agent: args.agent, connection: args.connection },
                  { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
                );
          break;
        }
        case 'agent.setConnection': {
          const args = OPS[op].input.parse(raw);
          built = A.setConnection(document, args, {
            catalog: catalog(),
            defaultAdapter: DEFAULT_AGENT,
          });
          break;
        }
        case 'agent.setSettings': {
          const args = OPS[op].input.parse(raw);
          built = A.setSettings(document, {
            ...args,
            change: Object.fromEntries(
              Object.entries(args.settings).filter(([, value]) => value !== undefined),
            ),
          });
          break;
        }
        case 'agent.setRole': {
          const args = OPS[op].input.parse(raw);
          built = A.setRole(document, args);
          break;
        }
        case 'queue.add': {
          const { agent, entry, into } = OPS[op].input.parse(raw);
          const made = Q.add(
            document,
            { agent, entry: entry as QueueEntry, ...(into === undefined ? {} : { into }) },
            'you',
            context.newId,
          );
          built = { next: made.next, result: { id: made.result.item } };
          break;
        }
        case 'queue.remove':
          built = Q.remove(document, OPS[op].input.parse(raw));
          break;
        case 'queue.move': {
          const args = OPS[op].input.parse(raw);
          built = Q.move(document, {
            agent: args.agent,
            item: args.item,
            before: args.before ?? null,
          });
          break;
        }
        case 'queue.update': {
          const { agent, item, change } = OPS[op].input.parse(raw);
          built = Q.update(document, { agent, item, change: change as QueueChange }, 'you');
          break;
        }
        case 'canvas.addAgent': {
          const args = OPS[op].input.parse(raw);
          const added = S.addAgent(document, args, context);
          built =
            args.connection === undefined || !('id' in added.result)
              ? added
              : {
                  ...added,
                  next: A.setConnection(
                    added.next,
                    { agent: added.result.id, connection: args.connection },
                    { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
                  ).next,
                };
          break;
        }
        case 'canvas.spawnAgent':
          built = S.spawnAgent(document, OPS[op].input.parse(raw), context);
          break;
        case 'canvas.rename': {
          const { node, label } = OPS[op].input.parse(raw);
          built = S.rename(document, { id: node, label });
          break;
        }
        case 'canvas.delete': {
          const args = OPS[op].input.parse(raw);
          built = S.remove(document, {
            nodes: args.nodes ?? [],
            links: (args.links ?? []).map(({ a, b }) => ({ source: a, target: b })),
          });
          break;
        }
        case 'canvas.link': {
          const { a, b, dots } = OPS[op].input.parse(raw);
          built = S.link(document, {
            source: a,
            target: b,
            ...(dots ? { dots } : {}),
          });
          break;
        }
        case 'canvas.unlink': {
          const { a, b } = OPS[op].input.parse(raw);
          built = S.unlink(document, { source: a, target: b });
          break;
        }
        case 'canvas.group':
          built = S.group(document, OPS[op].input.parse(raw), context);
          break;
        case 'canvas.ungroup':
          built = S.ungroup(document, OPS[op].input.parse(raw));
          break;
        case 'canvas.addParent': {
          const { frame } = OPS[op].input.parse(raw);
          built = S.addParent(document, { id: frame }, context);
          break;
        }
        case 'canvas.move':
          built = S.move(document, OPS[op].input.parse(raw));
          break;
        case 'canvas.setArrange': {
          const { on } = OPS[op].input.parse(raw);
          built = {
            next:
              on === document.arrange
                ? document
                : on
                  ? arrange({ ...document, arrange: true })
                  : { ...document, arrange: false },
            result: {},
          };
          break;
        }
        case 'canvas.insertTemplate': {
          const args = OPS[op].input.parse(raw);
          const template = exampleOf(args.template);
          if (!template) throw new Error('No template');
          const part = withConnections(
            withAgents(
              fillTemplate(fromFile(template.text, catalog(), DEFAULT_AGENT), args.values),
              Object.fromEntries(
                Object.entries(args.agents).map(([key, value]) => [key, value ?? undefined]),
              ),
              { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
            ),
            args.connections,
            { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
          );
          const made = insert(
            document,
            part,
            args.parent === undefined ? {} : { parent: args.parent },
            context,
          );
          built = {
            next: made.next,
            result: {
              roots: made.result.roots,
              agents: made.next.nodes
                .filter(
                  (node) =>
                    node.type === 'agent' && !document.nodes.some((old) => old.id === node.id),
                )
                .map((node) => node.id),
            },
          };
          break;
        }
        default:
          throw new Error(`No fake canvas operation ${op}`);
      }
      // Match the core's structural commit wrapper and template insertion. Explicit moves,
      // renames, agent/queue edits and an unchanged Arrange setting do not trigger layout.
      const structural: readonly GuiOp[] = [
        'canvas.addAgent',
        'canvas.spawnAgent',
        'canvas.delete',
        'canvas.link',
        'canvas.unlink',
        'canvas.group',
        'canvas.ungroup',
        'canvas.addParent',
        'canvas.insertTemplate',
      ];
      const next =
        structural.includes(op) && built.next !== document && built.next.arrange
          ? arrange(built.next)
          : built.next;
      const revision = keep(next);
      return Promise.resolve({
        ok: true,
        value: { ...(built.result as object), revs: { [`canvas:${document.id}`]: revision } },
      });
    });
  return {
    core,
    usageSource: {
      topics: {
        snapshot: usage.snapshot,
        subscribe: (_topic, listener) => usage.subscribe(listener),
      },
      setRule: (backend, rule) => {
        usage.setRule(backend, rule);
        return Promise.resolve();
      },
      simulate: (backend, windows) => {
        usage.simulate(backend, windows);
        return Promise.resolve();
      },
    } satisfies UsageSource,
    run: (next?: Run) => runtime?.run(next),
    session: (agent: string, session?: Session) => runtime?.session(agent, session),
    messages: (items: readonly MessageView[]) => runtime?.messages(items),
    create,
    open,
    get document() {
      return document;
    },
    get rev() {
      return rev;
    },
    edit(text: string, expected: number): Promise<number> {
      if (expected !== rev) return Promise.reject(new Error('Stale test canvas'));
      return Promise.resolve(keep(fromFile(text, catalog(), DEFAULT_AGENT)));
    },
    files,
    meta: view,
  };
}
export const emptyCanvas = (id: CanvasId = newCanvasId()): CanvasDocument => ({
  id,
  arrange: false,
  nodes: [],
  links: [],
});
