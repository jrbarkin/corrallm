import { UNHOSTED } from './unhosted';

/*
 * Every operation of corrallm's one API, as plain data (Core Server §3.1): who may call it (its
 * audience), its kind and scope, the rules that narrow what a token may do with it, whether an
 * agent may aim it at itself, which result fields differ by caller, and the state the GUI reads
 * instead of calling it. The GUI's IPC and the agents' MCP are both generated from this one list,
 * and core.call checks the audience on every call, whatever the transport. Each op's schemas sit
 * beside it (ops/*.ts, registry.ts). Plain data, importing only the list of what the app doesn't
 * host yet (unhosted.ts): the preload imports it.
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

/**
 * The rules that narrow what a token may do (Core Server §3.6: R1 to R13, by key; and B9 Design
 * §4's R14, `managers`).
 */
export type Rule =
  | 'shell-text'
  | 'mode-permits'
  | 'human-choice'
  | 'discard'
  | 'restore-code'
  | 'self'
  | 'human-gate'
  | 'connection'
  | 'sticky'
  | 'team'
  | 'new-agent'
  | 'role'
  | 'links'
  | 'managers';

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
  /**
   * It removes or replaces what owns scopes beneath its own (B9 Design §3): from when it comes
   * until it ends, it holds the whole canvas ('canvas': closing it, or, in the app's scope,
   * replacing the canvas its `replace` names, if it names one), or the agents its arguments remove
   * or switch ('agents'), aborting what runs there, then takes its turn as usual. Only in the app's
   * scope or a canvas's.
   */
  readonly drains?: 'canvas' | 'agents';
  /**
   * It waits for what comes (a long poll): a token's limit on calls in flight leaves it out, and
   * its limit on waits in flight counts it instead. Only a read on MCP alone (the transport
   * deviation).
   */
  readonly waits?: true;
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

/*
 * The audiences ops share (Core Server §4's shorthands), which the core's test registry uses too.
 */

/** Reads no agent makes: you, and outside tokens on their canvases. */
export const O = { you: 'all', 'outside-read': 'canvas', 'outside-write': 'canvas' } as const;
/** Reads leads make too, on the agents they reach. */
export const R = { ...O, lead: 'linked' } as const;
/** Reads every caller makes: you, leads and workers on the agents they reach, outside tokens. */
export const A = { ...R, worker: 'linked' } as const;
/** Operations only you may call, in the GUI. */
export const Y = { you: 'all' } as const;
/** Writes on agents and queues: you; leads, on their team; outside write tokens. */
export const L = { you: 'all', lead: 'team', 'outside-write': 'canvas' } as const;
/**
 * Canvas-wide writes no agent makes, and resuming another conversation: you, and outside write
 * tokens (a lead acts only on its team).
 */
export const W = { you: 'all', 'outside-write': 'canvas' } as const;
/** Conversation writes: you; leads and workers, on the agents they reach; outside write tokens. */
export const M = {
  you: 'all',
  lead: 'linked',
  worker: 'linked',
  'outside-write': 'canvas',
} as const;
/** Outside tokens alone, read-only or read-write, on their canvases. */
const T = { 'outside-read': 'canvas', 'outside-write': 'canvas' } as const;

export const SURFACE = {
  'topics.subscribe': { access: Y, kind: 'command', scope: 'none' },
  'topics.unsubscribe': { access: Y, kind: 'command', scope: 'none' },
  'app.info': { access: A, kind: 'read', scope: 'none' },
  'catalog.get': { access: A, kind: 'read', scope: 'none', reads: 'catalog' },
  'catalog.installed': { access: R, kind: 'read', scope: 'none' },
  'templates.list': { access: R, kind: 'read', scope: 'none' },
  'settings.get': { access: R, kind: 'read', scope: 'none', reads: 'settings' },
  'project.files': { access: R, kind: 'read', scope: 'none', self: 'allowed' },
  // A canvas's lifetime and where it is kept (B9 Design §1, §8). A path comes only from a dialog
  // you complete (D1: canvas.open, canvas.saveAs, project.choose). A token's call that would
  // discard work, or close a canvas a window shows, comes to you as a proposal (R4's argument
  // half). Closing or replacing a canvas drains it, as choosing its folder does.
  'canvas.create': {
    access: W,
    kind: 'command',
    scope: 'app',
    rules: ['discard', 'new-agent'],
    drains: 'canvas',
    destructive: true,
  },
  'canvas.open': { access: Y, kind: 'command', scope: 'app', drains: 'canvas' },
  'canvas.save': {
    access: W,
    kind: 'command',
    scope: 'canvas',
    rules: ['discard'],
    destructive: true,
  },
  'canvas.saveAs': { access: Y, kind: 'command', scope: 'canvas' },
  'canvas.close': {
    access: W,
    kind: 'command',
    scope: 'canvas',
    rules: ['discard'],
    drains: 'canvas',
    destructive: true,
  },
  'project.choose': { access: Y, kind: 'command', scope: 'canvas', drains: 'canvas' },
  // What a new worktree of the picked repository runs to set itself up (B9a Design §14 item 2):
  // yours alone, as the pick is (D1, trust-gate), never a token's, a file's or the repository's.
  'project.setSetupCommand': { access: Y, kind: 'command', scope: 'canvas' },
  // What runs by itself in a new worktree is yours to stop allowing (D9, permissions).
  'project.clearSetupApproval': { access: Y, kind: 'command', scope: 'canvas' },
  // A token lists only its own canvases; a lead's canvas holds only what it reaches (§3.4).
  'canvas.list': { access: R, kind: 'read', scope: 'none', reads: 'canvases', varies: ['items'] },
  'canvas.get': {
    access: R,
    kind: 'read',
    scope: 'none',
    reads: 'canvas',
    varies: ['nodes', 'links', 'entities'],
  },
  'canvas.rename': { access: L, kind: 'doc', scope: 'canvas', self: 'allowed' },
  'canvas.insertTemplate': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    self: 'allowed',
    rules: ['new-agent'],
  },
  'canvas.setArrange': { access: W, kind: 'doc', scope: 'canvas' },
  'canvas.addAgent': { access: L, kind: 'doc', scope: 'canvas', rules: ['new-agent'] },
  'canvas.spawnAgent': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['new-agent'],
    self: 'allowed',
  },
  // A token's delete of an agent comes to you as a proposal (R4), unless another rule refuses it.
  'canvas.delete': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['human-gate', 'links', 'discard'],
    self: 'refused',
    drains: 'agents',
    destructive: true,
  },
  'canvas.link': { access: L, kind: 'doc', scope: 'canvas', rules: ['links'], self: 'allowed' },
  'canvas.unlink': { access: L, kind: 'doc', scope: 'canvas', rules: ['links'], self: 'allowed' },
  'canvas.group': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['new-agent', 'managers'],
    self: 'allowed',
  },
  'canvas.ungroup': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['managers'],
    self: 'allowed',
  },
  'canvas.addParent': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['new-agent', 'managers'],
    self: 'allowed',
  },
  'canvas.move': { access: L, kind: 'doc', scope: 'canvas', self: 'allowed' },
  // Several doc ops as one commit: every change rule a batch can meet is checked on its whole
  // change (R8 only through agent.setConnection or agent.setType, which are yours alone), and each
  // inner op is checked as the caller's own call, its own `self` included. It drains the agents its
  // inner ops would.
  'canvas.batch': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: [
      'discard',
      'mode-permits',
      'self',
      'human-gate',
      'new-agent',
      'role',
      'links',
      'managers',
    ],
    self: 'allowed',
    drains: 'agents',
    destructive: true,
  },
  'agent.setType': {
    access: Y,
    kind: 'doc',
    scope: 'canvas',
    rules: ['connection'],
    drains: 'agents',
  },
  'agent.setConnection': {
    access: Y,
    kind: 'doc',
    scope: 'canvas',
    rules: ['connection'],
    drains: 'agents',
  },
  'agent.setSettings': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['mode-permits', 'self'],
    self: 'refused',
  },
  'agent.setRole': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['self', 'role'],
    self: 'refused',
  },
  // Adding carries no rule: an OK, or work after one, is a token's to add (revision R34).
  'queue.add': { access: L, kind: 'doc', scope: 'canvas', self: 'allowed' },
  'queue.remove': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['human-gate'],
    self: 'allowed',
    destructive: true,
  },
  'queue.move': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['human-gate'],
    self: 'allowed',
  },
  'queue.update': {
    access: L,
    kind: 'doc',
    scope: 'canvas',
    rules: ['human-gate'],
    self: 'allowed',
  },
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
  // Answers a Needs item its caller may answer: in B9, a proposal (yours alone, R3); in B9a, a
  // worktree's setup card, yours alone too.
  reply: { access: M, kind: 'command', scope: 'canvas', rules: ['human-choice'] },
  'session.open': { access: L, kind: 'command', scope: 'agent', self: 'allowed' },
  // D9: the mode an agent runs in is yours alone.
  'session.setMode': { access: Y, kind: 'command', scope: 'agent' },
  'session.setModel': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.setEffort': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.stopTask': {
    access: L,
    kind: 'command',
    scope: 'agent',
    self: 'allowed',
    destructive: true,
  },
  'session.restart': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.newConversation': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.rewindPreview': { access: R, kind: 'read', scope: 'none', self: 'allowed' },
  // R5: a token's code restore comes to you as a proposal; R6 refuses an agent's own first.
  'session.rewind': {
    access: L,
    kind: 'command',
    scope: 'agent',
    rules: ['restore-code'],
    self: 'refused',
    destructive: true,
  },
  // §16.1: Continue in Terminal, yours alone (how an agent runs is yours).
  'session.continueIn': { access: Y, kind: 'command', scope: 'agent' },
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
  'run.get': {
    access: R,
    kind: 'read',
    scope: 'none',
    reads: 'run',
    varies: ['agents', 'groups', 'saveError'],
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
  // The whole run (Core Server §4 F): canvas-wide, so no lead gets them. Run again takes back what
  // the run has in flight. R9: a token resumes, or starts afresh, only what no other party stopped,
  // decided in or holds for you to decide.
  'run.start': {
    access: W,
    kind: 'command',
    scope: 'canvas',
    rules: ['sticky'],
    destructive: true,
  },
  'run.stop': { access: W, kind: 'command', scope: 'canvas', preempt: true, destructive: true },
  'run.resume': { access: W, kind: 'command', scope: 'canvas', rules: ['sticky'] },
  // Go on now: a usage rule's hold is yours to end (R3).
  'run.goOn': {
    access: L,
    kind: 'command',
    scope: 'agent',
    rules: ['human-choice'],
    self: 'allowed',
  },
  'usage.get': { access: A, kind: 'read', scope: 'none', reads: 'usage' },
  'usage.setRule': { access: Y, kind: 'command', scope: 'app' },
  'usage.simulate': { access: Y, kind: 'command', scope: 'app' },
  'link.open': { access: Y, kind: 'command', scope: 'none' },
  'link.reveal': { access: Y, kind: 'command', scope: 'none' },
  'window.get': { access: Y, kind: 'read', scope: 'none' },
  'window.show': { access: Y, kind: 'command', scope: 'none' },
  'terminal.attach': { access: Y, kind: 'command', scope: 'none' },
  'terminal.detach': { access: Y, kind: 'command', scope: 'none' },
  'terminal.input': { access: Y, kind: 'command', scope: 'none' },
  'terminal.resize': { access: Y, kind: 'command', scope: 'none' },
  'terminal.drop': { access: Y, kind: 'command', scope: 'none' },
  wait: { access: T, kind: 'read', scope: 'none', waits: true, varies: ['messages', 'next'] },
} as const satisfies Record<string, Surface>;

export type OpName = keyof typeof SURFACE;

/** Every operation, by name. */
export const OP_NAMES = Object.keys(SURFACE) as OpName[];

/** The operations a window may call: those you may call that the app hosts (unhosted.ts). */
export type GuiOp = Exclude<
  { [N in OpName]: 'you' extends keyof (typeof SURFACE)[N]['access'] ? N : never }[OpName],
  keyof typeof UNHOSTED
>;

/**
 * Every operation a window may call, by name: what its port serves (core/gui.ts) and the preload
 * exposes, one function each. Any other is refused before it is dispatched.
 */
export const GUI_OPS = OP_NAMES.filter(
  (name): name is GuiOp => 'you' in SURFACE[name].access && !(name in UNHOSTED),
);
