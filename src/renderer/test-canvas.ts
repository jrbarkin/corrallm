import type { CanvasId } from '../shared/canvas';
import { newCanvasId } from '../shared/canvas';
import { OPS } from '../shared/api/registry';
import type { GuiOp } from '../shared/api/surface';
import type { CanvasDocument } from '../shared/model/canvas';
import { fromFile, toFile } from '../shared/model/file';
import { diffRows } from '../shared/model/rows';
import type { Entities, Entity, MetaEntity } from '../shared/model/state';
import * as S from '../shared/model/structure';
import { arrange } from '../shared/model/layout';
import { insert } from '../shared/model/insert';
import { fillTemplate, withAgents, withConnections } from '../shared/model/templates';
import { exampleOf } from '../shared/examples';
import { catalog } from './catalog';
import { DEFAULT_AGENT } from './graph/agents';
import { fakeCore } from './test-api';

/** An in-memory canvas core for editor gesture tests: real schemas and pure builds, pushed rows. */
export function fakeCanvas(initial: CanvasDocument) {
  const core = fakeCore();
  let document = initial;
  let rev = 1;
  let saved = toFile(initial);
  let entities: Entities = {};
  let rows = diffRows({}, initial).rows;
  const meta = {
    name: null as string | null,
    edited: false,
    project: null as { name: string; path: string } | null,
  };
  const source = core.topics.snapshot.bind(core.topics);
  const revision = core.topics.revision.bind(core.topics);
  core.topics.snapshot = (topic) => source(topic) ?? core.state(topic)?.state;
  core.topics.revision = (topic) => revision(topic) ?? core.state(topic)?.rev;
  const context = { newId: () => crypto.randomUUID(), defaultAdapter: DEFAULT_AGENT };
  const keep = (next: CanvasDocument) => {
    const prior = document;
    if (toFile(next) === toFile(prior)) return rev;
    const changed = diffRows(rows, next, prior);
    rows = changed.rows;
    document = next;
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
  const open = (next: CanvasDocument) => {
    const prior = core.state(`canvas:${next.id}`);
    document = next;
    rev = prior ? prior.rev + 1 : 1;
    saved = toFile(next);
    meta.edited = false;
    rows = diffRows({}, next).rows;
    entities = Object.fromEntries(
      Object.entries(rows).map(([key, row]) => [key, { ...row, rev, by: 'you' }]),
    ) as Entities;
    entities = { ...entities, meta: { arrange: next.arrange, ...meta, rev, by: 'you' } };
    if (prior) core.change({ topic: `canvas:${next.id}`, rev, replace: entities });
    else core.snapshot(`canvas:${next.id}`, entities, rev);
    core.respond('window.get', { canvas: next.id });
  };
  open(initial);
  const ops: GuiOp[] = [
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
        case 'canvas.addAgent':
          built = S.addAgent(document, OPS[op].input.parse(raw), context);
          break;
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
          built = { next: { ...document, arrange: on }, result: {} };
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
          const made = insert(document, part, { name: template.name }, context);
          const group = made.result.id;
          built = {
            next: made.next,
            result: {
              group,
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
      const next = built.next.arrange ? arrange(built.next) : built.next;
      const revision = keep(next);
      return Promise.resolve({
        ok: true,
        value: { ...(built.result as object), revs: { [`canvas:${document.id}`]: revision } },
      });
    });
  return {
    core,
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
    meta(next: Partial<typeof meta>) {
      if (next.edited === false) saved = toFile(document);
      Object.assign(meta, next);
      rev++;
      entities = { ...entities, meta: { ...meta, arrange: document.arrange, rev, by: 'you' } };
      core.change({
        topic: `canvas:${document.id}`,
        rev,
        set: { meta: entities.meta as MetaEntity },
      });
    },
  };
}
export const emptyCanvas = (id: CanvasId = newCanvasId()): CanvasDocument => ({
  id,
  arrange: false,
  nodes: [],
  links: [],
});
