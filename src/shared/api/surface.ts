/*
 * Every operation of corrallm's one API, as plain data (Core Server §3.1): who may call it (its
 * audience), its kind and scope, the rules that narrow what a token may do with it, whether an
 * agent may aim it at itself, which result fields differ by caller, and the state the GUI reads
 * instead of calling it. The GUI's IPC and the agents' MCP are both generated from this one list,
 * and core.call checks the audience on every call, whatever the transport. Each op's schemas sit
 * beside it (ops/*.ts, registry.ts). No imports: the preload may import it.
 */

/**
 * Who calls: you (only ever over a window's port), an agent you made a lead, any other agent, or an
 * outside token, read-only or read-write.
 */
export const PARTIES = ['you', 'lead', 'worker', 'outside-read', 'outside-write'] as const;
export type Party = (typeof PARTIES)[number];

/**
 * How far a party reaches. 'canvas': every agent on its canvases (an outside token's granted ones,
 * plus any its party created). 'linked': itself, its manager and the agents linked to it, plus a
 * lead's team. 'team': itself and every agent nested inside it, at any depth. 'own': itself.
 */
export type Reach = 'all' | 'canvas' | 'team' | 'linked' | 'own';

/** An op's audience: the parties that may call it, and how far each reaches for it. */
export type Access = { readonly you?: 'all' } & Readonly<
  Partial<Record<Exclude<Party, 'you'>, Reach>>
>;

/** Ops in one scope run one at a time (core/scopes.ts): the app's, a canvas's, an agent's. */
export type Scope = 'app' | 'canvas' | 'agent' | 'none';

/** The rules that narrow what a token may do (Core Server §3.6: R1 to R13, by key). */
export type Rule =
  | 'shell-text'
  | 'mode-permits'
  | 'human-choice'
  | 'discard'
  | 'restore-code'
  | 'human-gate'
  | 'connection'
  | 'sticky'
  | 'team'
  | 'new-agent'
  | 'role'
  | 'links';

/** 'read' changes nothing (MCP's readOnlyHint); 'doc' is a pure document edit; 'command' the rest. */
export type Kind = 'read' | 'doc' | 'command';

/** The state the GUI is pushed (Core Server §5.1), by kind. */
export type TopicKind =
  | 'canvases'
  | 'catalog'
  | 'settings'
  | 'usage'
  | 'canvas'
  | 'run'
  | 'needs'
  | 'sessions'
  | 'session'
  | 'messages'
  | 'activity';

export interface Surface {
  /** The op's audience, checked on every call: the GUI's if `you` is in it, MCP's for the rest. */
  readonly access: Access;
  readonly kind: Kind;
  readonly scope: Scope;
  /** It runs ahead of its scope's queue, aborting what it supersedes (an interrupt, a stop). */
  readonly preempt?: true;
  /** It removes, discards or interrupts: MCP's destructiveHint. */
  readonly destructive?: true;
  /** The rules checked on its arguments in core.call, and on its change at commit. */
  readonly rules?: readonly Rule[];
  /** Whether an agent may aim it at itself: declared on every op a token may call naming an agent. */
  readonly self?: 'allowed' | 'refused';
  /** The result's fields that differ by who calls (Core Server §3.4). */
  readonly varies?: readonly string[];
  /** The topic the GUI reads this state from, instead of calling the op. */
  readonly reads?: TopicKind;
}

/** Reads no agent makes: you, and outside tokens on their canvases. */
const O = { you: 'all', 'outside-read': 'canvas', 'outside-write': 'canvas' } as const;
/** Reads leads make too, on the agents they reach. */
const R = { ...O, lead: 'linked' } as const;
/** Reads every caller makes: you, leads and workers on the agents they reach, outside tokens. */
const A = { ...R, worker: 'linked' } as const;
/** Writes on agents and queues: you; leads, on their team; outside write tokens. */
const L = { you: 'all', lead: 'team', 'outside-write': 'canvas' } as const;
/** Conversation writes: you; leads and workers, on the agents they reach; outside write tokens. */
const M = { you: 'all', lead: 'linked', worker: 'linked', 'outside-write': 'canvas' } as const;

export const SURFACE = {
  'app.info': { access: A, kind: 'read', scope: 'none' },
  'catalog.get': { access: A, kind: 'read', scope: 'none', reads: 'catalog' },
  agents: { access: A, kind: 'read', scope: 'none', varies: ['agents'] },
  status: {
    access: R,
    kind: 'read',
    scope: 'none',
    varies: ['agents', 'waitingForYou', 'next'],
  },
  needs: { access: A, kind: 'read', scope: 'none', reads: 'needs', varies: ['items'] },
  messages: {
    access: A,
    kind: 'read',
    scope: 'none',
    reads: 'messages',
    varies: ['items', 'next'],
  },
  message: {
    access: M,
    kind: 'command',
    scope: 'agent',
    rules: ['shell-text'],
    self: 'refused',
  },
  withdraw: { access: M, kind: 'command', scope: 'canvas', preempt: true, destructive: true },
  'session.get': {
    access: A,
    kind: 'read',
    scope: 'none',
    reads: 'sessions',
    self: 'allowed',
  },
  'session.transcript': {
    access: { ...R, worker: 'own' },
    kind: 'read',
    scope: 'none',
    reads: 'session',
    self: 'allowed',
    // An MCP server's link (a sign-in) is yours alone (R3).
    varies: ['entries'],
  },
  'session.interrupt': {
    access: L,
    kind: 'command',
    scope: 'agent',
    preempt: true,
    destructive: true,
    self: 'refused',
  },
  'run.pause': { access: L, kind: 'command', scope: 'agent', self: 'allowed' },
  'run.kill': {
    access: L,
    kind: 'command',
    scope: 'agent',
    preempt: true,
    destructive: true,
    self: 'allowed',
  },
  'run.unpause': {
    access: L,
    kind: 'command',
    scope: 'agent',
    rules: ['sticky'],
    self: 'allowed',
  },
  'usage.get': { access: A, kind: 'read', scope: 'none', reads: 'usage' },
} as const satisfies Record<string, Surface>;

export type OpName = keyof typeof SURFACE;

/** Every operation, by name. */
export const OP_NAMES = Object.keys(SURFACE) as OpName[];

/** The operations the GUI is the audience for: those you may call. */
export const GUI_OPS = OP_NAMES.filter((name) => 'you' in SURFACE[name].access);
