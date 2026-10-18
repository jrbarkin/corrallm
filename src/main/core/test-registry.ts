import { z } from 'zod';

import { withEnvelope } from '../../shared/api/define';
import type { OpDef } from '../../shared/api/define';
import { brandedId, idsIn, NeedId } from '../../shared/api/ids';
import type { Brand, IdRef } from '../../shared/api/ids';
import { PARTIES } from '../../shared/api/surface';
import type { OpName, Party, Reach, Rule, Surface } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { Dispatcher, Implementation, OpContext, Registry, RuleCheck } from './call';
import { asHuman } from './caller';
import type { AgentCaller, Caller, OutsideCaller, TokenCaller } from './caller';
import type { HostServices } from './host';
import type { Resolver } from './reach';

/*
 * A registry made for the core's tests: an op for each thing core.call checks (an audience, ids
 * and their reach, an agent aiming at itself, a rule that refuses and one that proposes, results
 * that differ by caller), a canvas of agents for ids to name, a caller for every party, and what
 * each party doesn't reach on it. The dispatcher, MCP and the generated tests (T3a, T3b) run it
 * beside the real registry.
 */

export const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
export const OTHER_CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c' as CanvasId;
export const PROPOSAL = NeedId.parse('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d');

/**
 * The canvas's agents: `lead` (a lead, whose team is `helper`, nested inside it), `worker` (with
 * `apprentice` nested inside it, which is no team: the worker isn't a lead), `peer` (linked to
 * the lead and the worker), and `stranger`, linked to nobody.
 */
const AGENTS = ['lead', 'helper', 'worker', 'apprentice', 'peer', 'stranger'];
const LINKS = [
  ['worker', 'peer'],
  ['lead', 'peer'],
];
const NESTED: Readonly<Record<string, readonly string[]>> = {
  lead: ['helper'],
  worker: ['apprentice'],
};
const MANAGERS: Readonly<Record<string, string>> = { helper: 'lead', apprentice: 'worker' };

export const isLead = (canvas: CanvasId, agent: string) => canvas === CANVAS && agent === 'lead';

const linked = (a: string, b: string) =>
  LINKS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
/** A lead's team: the agents nested inside it. */
const inTeam = (lead: string, agent: string) =>
  isLead(CANVAS, lead) && (NESTED[lead] ?? []).includes(agent);

/** Whether `caller` reaches the agent `id` as far as `reach`, on the fixture canvas. */
function reachesAgent(id: string, caller: TokenCaller, reach: Reach): boolean {
  if (!AGENTS.includes(id)) return false;
  if (caller.kind === 'outside') return reach === 'canvas' && caller.canvases.includes(CANVAS);
  const self = caller.agent;
  switch (reach) {
    case 'own':
      return id === self;
    case 'team':
      return id === self || inTeam(self, id);
    case 'linked':
      return id === self || linked(self, id) || MANAGERS[self] === id || inTeam(self, id);
    default:
      return false;
  }
}

export const RESOLVERS: Readonly<Record<string, Resolver>> = {
  CanvasId: (id, caller) =>
    caller.kind === 'outside' ? caller.canvases.includes(id as CanvasId) : caller.canvas === id,
  AgentId: (id, caller, reach, canvas) =>
    (canvas === undefined || canvas === CANVAS) && reachesAgent(id, caller, reach),
};

const Canvas = brandedId('CanvasId', z.uuid());
const Agent = brandedId('AgentId', z.string().min(1).max(64));

const Y = { you: 'all' } as const;
const T = {
  lead: 'linked',
  worker: 'linked',
  'outside-read': 'canvas',
  'outside-write': 'canvas',
} as const;
const A = {
  you: 'all',
  lead: 'linked',
  worker: 'linked',
  'outside-read': 'canvas',
  'outside-write': 'canvas',
} as const;
const L = { you: 'all', lead: 'team', 'outside-write': 'canvas' } as const;
const M = { you: 'all', lead: 'linked', worker: 'linked', 'outside-write': 'canvas' } as const;
const W = { you: 'all', 'outside-write': 'canvas' } as const;

const SURFACES = {
  'test.read': { access: A, kind: 'read', scope: 'none', varies: ['caller'] },
  'test.tokens': { access: T, kind: 'read', scope: 'none' },
  'test.yours': { access: Y, kind: 'command', scope: 'none' },
  'test.agent': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'test.message': {
    access: M,
    kind: 'command',
    scope: 'agent',
    rules: ['shell-text'],
    self: 'refused',
  },
  'test.delete': {
    access: W,
    kind: 'command',
    scope: 'canvas',
    destructive: true,
    rules: ['discard'],
    self: 'refused',
  },
  'test.hold': { access: A, kind: 'read', scope: 'agent' },
  'test.stop': { access: A, kind: 'command', scope: 'agent', preempt: true, destructive: true },
} as const satisfies Record<string, Surface>;
type Name = keyof typeof SURFACES;

const define = <
  N extends Name,
  I extends z.ZodObject<z.core.$ZodShape, z.core.$strict>,
  O extends z.ZodType,
>(
  name: N,
  def: OpDef<I, O>,
) => withEnvelope(SURFACES[name], def);

const OPS = {
  'test.read': define('test.read', {
    summary: 'Says who called, and something that is the same for everyone.',
    input: z.strictObject({}),
    output: z.strictObject({ caller: z.string(), same: z.number() }),
  }),
  'test.tokens': define('test.tokens', {
    summary: 'Something only tokens may do, as waiting for what is addressed to them.',
    input: z.strictObject({}),
    output: z.strictObject({ done: z.boolean() }),
  }),
  'test.yours': define('test.yours', {
    summary: 'Something only you may do.',
    input: z.strictObject({}),
    output: z.strictObject({ done: z.boolean() }),
  }),
  'test.agent': define('test.agent', {
    summary: 'Acts on an agent.',
    input: z.strictObject({ canvas: Canvas, agent: Agent }),
    output: z.strictObject({ agent: z.string() }),
  }),
  'test.message': define('test.message', {
    summary: 'Sends an agent text, which a token may not start with "!".',
    input: z.strictObject({ canvas: Canvas, to: Agent, body: z.string().min(1).max(100) }),
    output: z.strictObject({ sent: z.string() }),
  }),
  'test.delete': define('test.delete', {
    summary: 'Deletes an agent: a token’s call comes to you as a proposal.',
    input: z.strictObject({ canvas: Canvas, agent: Agent }),
    output: z.strictObject({ deleted: z.string() }),
  }),
  'test.hold': define('test.hold', {
    summary: 'Holds its agent’s scope until stopped.',
    input: z.strictObject({ canvas: Canvas, agent: Agent }),
    output: z.strictObject({ stopped: z.boolean() }),
  }),
  'test.stop': define('test.stop', {
    summary: 'Stops what holds its agent’s scope.',
    input: z.strictObject({ canvas: Canvas, agent: Agent }),
    output: z.strictObject({ stopped: z.boolean() }),
  }),
} satisfies Record<Name, OpDef>;

/** What each fixture op did, by name: the arguments of each call that reached it. */
export type Calls = Record<Name, unknown[]>;

/** The fixture registry, with its implementations recording each call that reaches them. */
export function testRegistry(): Registry & {
  implementations: Record<string, Implementation>;
  calls: Calls;
  /** Why each test.hold stopped holding: its signal's reason. */
  released: unknown[];
} {
  const calls: Calls = {
    'test.read': [],
    'test.tokens': [],
    'test.yours': [],
    'test.agent': [],
    'test.message': [],
    'test.delete': [],
    'test.hold': [],
    'test.stop': [],
  };
  const released: unknown[] = [];
  const heard =
    <A, R>(name: Name, implementation: (args: A, ctx: OpContext) => R) =>
    (args: A, ctx: OpContext): R => {
      calls[name].push(args);
      return implementation(args, ctx);
    };
  const implementations: Record<Name, Implementation> = {
    'test.read': heard('test.read', (_args, { party }) => ({ caller: party, same: 1 })),
    'test.tokens': heard('test.tokens', () => ({ done: true })),
    'test.yours': heard('test.yours', () => ({ done: true })),
    'test.agent': heard('test.agent', ({ agent }: { agent: string }) => ({ agent })),
    'test.message': heard('test.message', ({ to }: { to: string }) => ({ sent: to })),
    'test.delete': heard('test.delete', ({ agent }: { agent: string }) => ({ deleted: agent })),
    'test.hold': heard(
      'test.hold',
      (_args, { signal }) =>
        new Promise<{ stopped: boolean }>((resolve) => {
          signal.addEventListener('abort', () => {
            released.push(signal.reason);
            resolve({ stopped: true });
          });
        }),
    ),
    'test.stop': heard('test.stop', () => ({ stopped: true })),
  };
  const rules: Partial<Record<Rule, RuleCheck>> = {
    'shell-text': ({ body }: { body: string }) =>
      body.startsWith('!') ? { refuse: 'Only what you typed may run a shell command.' } : undefined,
    discard: () => ({ propose: PROPOSAL }),
  };
  return { surface: SURFACES, ops: OPS, implementations, rules, calls, released };
}

/** A caller for each party: you, the lead, a worker, and an outside token of each kind. */
export const CALLERS: Readonly<Record<Party, Caller>> = {
  you: asHuman(1),
  lead: {
    kind: 'agent',
    canvas: CANVAS,
    agent: 'lead',
    session: 'lead-session',
  } satisfies AgentCaller,
  worker: {
    kind: 'agent',
    canvas: CANVAS,
    agent: 'worker',
    session: 'worker-session',
  } satisfies AgentCaller,
  'outside-read': {
    kind: 'outside',
    token: 'read-token',
    name: 'watcher',
    access: 'read',
    canvases: [CANVAS],
  } satisfies OutsideCaller,
  'outside-write': {
    kind: 'outside',
    token: 'write-token',
    name: 'orchestrator',
    access: 'write',
    canvases: [CANVAS],
  } satisfies OutsideCaller,
};

/**
 * What the generated tests call each op with. `valid`: arguments it takes from everyone in its
 * audience, between them naming every kind of id it takes. `invalid`: arguments it refuses.
 * `meetsRule`: arguments that meet each of its rules. What a party doesn't reach is generated from
 * the valid arguments (`unreachableCalls`).
 */
export interface OpFixture {
  valid: readonly unknown[];
  invalid: readonly unknown[];
  meetsRule?: Partial<Record<Rule, unknown>>;
}

/**
 * The ids each token party doesn't reach, by kind, as far as an op lets it (`reach`): what T3b
 * puts in place of each id an op's valid arguments name, to see every one answered not-found.
 * Undefined: not said, which T3b refuses for any kind an op takes. None: nothing of that kind is
 * out of that reach (every agent on an outside token's canvases), so the op's other ids show it.
 */
export type OutOfReach = Readonly<
  Partial<Record<Brand, (caller: TokenCaller, reach: Reach) => readonly string[] | undefined>>
>;

/** A call of an op naming what a token party doesn't reach. */
export interface UnreachableCall {
  party: Party;
  args: unknown;
}

/**
 * The calls of op `name` naming what a token party doesn't reach (Core Server §3.7: reach,
 * generated per op and party): for each token party in its audience, each of its valid arguments
 * with each id in it swapped, in turn, for each id of its kind `world` says the party doesn't
 * reach, as far as the op lets it.
 */
export function unreachableCalls(
  core: Pick<Dispatcher, 'ops' | 'surface'>,
  name: string,
  fixture: OpFixture,
  world: OutOfReach,
): UnreachableCall[] {
  const def = core.ops[name];
  const surface = core.surface[name];
  if (!def || !surface) return [];
  return PARTIES.flatMap((party) => {
    const reach = party === 'you' ? undefined : surface.access[party];
    if (reach === undefined) return [];
    const caller = CALLERS[party] as TokenCaller;
    return fixture.valid.flatMap((args) =>
      idsIn(def.input, args).flatMap((ref) =>
        (world[ref.brand]?.(caller, reach) ?? []).map((id) => ({
          party,
          args: withId(args, ref, id),
        })),
      ),
    );
  });
}

/** `args` with `id` in place of the id `ref` found in it, by its path (`.agent`, `.nodes[0]`). */
function withId(args: unknown, ref: IdRef, id: string): unknown {
  const root: Record<PropertyKey, unknown> = { args: structuredClone(args) };
  let holder = root;
  let at: PropertyKey = 'args';
  for (const [, key, index] of ref.path.matchAll(/\.([^.[]+)|\[(\d+)\]/g)) {
    holder = holder[at] as Record<PropertyKey, unknown>;
    at = key ?? Number(index);
  }
  holder[at] = id;
  return root.args;
}

/** What the generated tests call each test op with: all but test.hold, which no call ends by itself. */
export const TEST_FIXTURES: Readonly<Record<Exclude<Name, 'test.hold'>, OpFixture>> = {
  'test.read': { valid: [{}, undefined], invalid: [{ extra: 1 }, 'text', [], null] },
  'test.tokens': { valid: [{}], invalid: [{ extra: 1 }] },
  'test.yours': { valid: [{}], invalid: [{ extra: 1 }] },
  'test.agent': {
    valid: [{ canvas: CANVAS, agent: 'helper' }],
    invalid: [
      { canvas: CANVAS },
      { canvas: 'nope', agent: 'helper' },
      { canvas: CANVAS, agent: '' },
    ],
  },
  'test.message': {
    valid: [{ canvas: CANVAS, to: 'peer', body: 'hello' }],
    invalid: [
      { canvas: CANVAS, to: 'peer', body: '' },
      { canvas: CANVAS, to: 'peer', body: 'x'.repeat(101) },
    ],
    meetsRule: { 'shell-text': { canvas: CANVAS, to: 'peer', body: '!rm -rf /' } },
  },
  'test.delete': {
    valid: [{ canvas: CANVAS, agent: 'stranger' }],
    invalid: [{ canvas: CANVAS, agent: 'stranger', extra: true }],
    meetsRule: { discard: { canvas: CANVAS, agent: 'stranger' } },
  },
  'test.stop': {
    valid: [{ canvas: CANVAS, agent: 'peer' }],
    invalid: [{ agent: 'peer' }],
  },
};

/**
 * The agents each agent doesn't reach on the fixture canvas, as far as an op lets it: said apart
 * from RESOLVERS, so that T3b checks them rather than repeating them.
 */
const AGENTS_OUT_OF_REACH: Readonly<Record<string, Partial<Record<Reach, readonly string[]>>>> = {
  // A lead's write reaches its team; its read, its links too.
  lead: {
    team: ['worker', 'apprentice', 'peer', 'stranger'],
    linked: ['worker', 'apprentice', 'stranger'],
  },
  // A worker reaches the agents linked to it, never its own children.
  worker: { linked: ['lead', 'helper', 'apprentice', 'stranger'] },
};

/** What each token party doesn't reach on the fixture canvas. */
export const TEST_OUT_OF_REACH: OutOfReach = {
  CanvasId: () => [OTHER_CANVAS],
  AgentId: (caller, reach) =>
    caller.kind === 'outside' ? [] : AGENTS_OUT_OF_REACH[caller.agent]?.[reach],
};

/** What the generated tests call each of the registry's operations with. */
export const REAL_FIXTURES: Readonly<Record<OpName, OpFixture>> = {
  'app.info': { valid: [{}, undefined], invalid: [{ verbose: true }, 'text', null] },
  'usage.get': { valid: [{}, undefined], invalid: [{ backend: 'any' }, [], null] },
};

/** What each token party doesn't reach in the core the registry runs on: no op takes an id yet. */
export const REAL_OUT_OF_REACH: OutOfReach = {};

/** A host with no desktop: every dialog is cancelled. */
export const NO_DESKTOP: HostServices = {
  pickCanvasToOpen: () => Promise.resolve(null),
  pickCanvasToSave: () => Promise.resolve(null),
  pickFolder: () => Promise.resolve(null),
};
