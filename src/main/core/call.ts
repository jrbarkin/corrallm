import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { PROPOSING_RULES } from '../../shared/api/define';
import type { OpDef } from '../../shared/api/define';
import { TOO_MANY_WAITS } from '../../shared/api/errors';
import type { Current, OpError, OpErrorCode, OpResult } from '../../shared/api/errors';
import { idsIn, UnreadableIds } from '../../shared/api/ids';
import type { Brand, IdRef, NeedId } from '../../shared/api/ids';
import type { Party, Rule, Surface } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { notPlainData } from '../../shared/link';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { PartyId } from '../../shared/model/messages';
import { callerKey, canvasesOf, partyIdOf, partyOf } from './caller';
import type { Committer } from './canvas/commit';
import type { Built } from './canvas/documents';
import type { Caller, TokenCaller } from './caller';
import type { Staged } from './delivery/messages';
import { outOfReach } from './reach';
import type { Resolver } from './reach';
import { Requests } from './requests';
import type { Attempt } from './requests';
import { Scopes, Superseded } from './scopes';
import { Throttle } from './throttle';

/*
 * core.call: the one dispatcher every transport calls (Core Server §3.1), a window's port and MCP
 * alike, so that no transport adds or skips anything. On every call, in this order, it checks the
 * caller's party against the op's audience (decision 2: a tool missing from a party's list is
 * refused when called anyway), admits a token's call within its limits, fills in the canvas a
 * caller left out (its only one, or the one holding a message it names), or asks a caller with
 * several to name one if its arguments otherwise fit, parses them with the op's one schema
 * (refusing text with a broken character, a lone surrogate, which the core's database can't keep
 * as it is), returns a caller's repeated request's first result (the same op, request id and
 * arguments; before reach, since what its first call did may have put what it names out of reach),
 * resolves every id a token names against its reach,
 * refuses an agent aiming at itself an op it may not, and runs the op in its scope, checking the
 * op's reach again there, then its rules on a token's arguments (a met rule refuses it, or makes it
 * a proposal for you), since they read what the ops before it in its scope left; its reach is
 * checked once more as each of its commits builds, in the canvas's turn, and so is each inner op's
 * of a batch, recomputing its party each time, since its authority and reach may change while it
 * waits. It never throws: a failure is a value, whose code survives any transport. An op may run
 * another as part of itself, in its own turn (`ctx.call`, `ctx.prepare`): checked as a call of its
 * caller's own would be (its audience,
 * arguments, reach, self and argument rules), never throttled, deduped or scoped apart; `ctx.call`
 * still drains and holds the inner op's lanes until it ends. A commit that a change rule makes a
 * proposal for you (R4) applies nothing: the op's result is `{ proposed }`.
 */

/**
 * An operation's failure, thrown by core.call's checks and by ops; it answers as a value, with what
 * the entities a conflict is over are now (`current`).
 */
export class OpFailure extends Error {
  readonly code: OpErrorCode;
  readonly current: Readonly<Record<string, Current>> | undefined;

  constructor(code: OpErrorCode, sentence: string, current?: Readonly<Record<string, Current>>) {
    super(sentence);
    this.name = 'OpFailure';
    this.code = code;
    this.current = current;
  }
}

/**
 * How a commit is made beyond what the call itself says (Allow's, B9 Design §5): recording the
 * party whose proposal you allowed, expecting the revisions its change touched and every entity
 * its replay now changes, and holding what else its write must (the settlement and its record).
 */
export interface CommitOptions {
  proposedBy?: PartyId;
  expect?: Readonly<Record<string, number>>;
  unchanged?: Readonly<Record<string, number>>;
  within?: () => Staged;
  /** A command's destructive cleanup runs after its proposal has settled. */
  after?: (cleanup: () => Promise<void>) => void;
  /** On Allow of a command proposal: what it was raised over (R5's guard), checked again. */
  guard?: unknown;
}

/**
 * What an op is called with besides its arguments: who called, as what party, its signal, and how
 * it changes a canvas's document.
 */
export interface OpContext {
  readonly caller: Caller;
  /** The caller's party now, including authority changed since this call began. */
  readonly party: Party;
  /** The party the caller is: what each change it commits is stamped with. */
  readonly by: PartyId;
  /** On Allow, the original proposer: defaults and filled text retain their original meaning. */
  readonly proposedBy?: PartyId;
  /** Aborts when a preempting op supersedes it, or its caller gives up: then it unwinds. */
  readonly signal: AbortSignal;
  /** Marks a direct document write irreversible, checking cancellation first, as commit does. */
  noReturn(): void;
  /** Defers a command's final cleanup until its successful proposal settlement. */
  readonly after?: (cleanup: () => Promise<void>) => void;
  /**
   * On Allow of a command proposal: what it was raised over (R5's guard: rewind-guard.ts), which
   * the op checks again before its effect, failing as a conflict (settled stale) on a difference.
   */
  readonly guard?: unknown;
  /**
   * Commits to canvas `canvas`'s document (the canvas the op names) what `build` makes of it,
   * purely, from the live one (B9 Design §3): checked against the revisions the call expects and,
   * for a token, the change rules, then written past the call's point of no return. Resolves with
   * the op's result once it is on disk, the revision it took the call's (`revs`); rejects, changing
   * nothing, if the canvas isn't open, an entity the call expects is at another revision (a
   * conflict, saying what each is now), a change rule refuses it, or it couldn't be written. A doc
   * op's implementation calls it at once, and once: what `prepare` reads its change from. A change
   * only you may make, from a token, rejects with ProposedInstead, which the op's result becomes.
   */
  commit<R>(canvas: string | undefined, build: (document: CanvasDocument) => Built<R>): Promise<R>;
  /**
   * Says the op changed canvas `canvas`'s document to its revision `rev` other than by `commit` (an
   * applied file review, which the canvas's document commits itself): the call's `revs` carry it.
   */
  reached(canvas: string, rev: number): void;
  /**
   * Runs op `name` with `args` as part of this one, in its turn, as the caller: checked as a call
   * of the caller's own would be (its audience, its arguments, the ids it names in reach, an agent
   * not aiming at itself what it may not, its argument rules), its commits made as `options` say.
   * Drains and holds the inner op's lanes until it ends. Its result, or `{ proposed }`; rejects as
   * that call would fail.
   */
  call(name: string, args: unknown, options?: CommitOptions): Promise<unknown>;
  /**
   * What the doc op `name` would build of a canvas's document with `args`, checked as `call` checks
   * it, for this op to commit together with others (canvas.batch). Rejects as that call would fail
   * before it commits.
   */
  prepare(name: string, args: unknown): Promise<(document: CanvasDocument) => Built<unknown>>;
}

/**
 * A commit that became a proposal for you, applying nothing: the op's result is `{ proposed }`.
 * Thrown by ctx.commit; an op lets it pass.
 */
export class ProposedInstead extends Error {
  readonly need: NeedId;

  constructor(need: NeedId) {
    super('It came to the user as a proposal.');
    this.name = 'ProposedInstead';
    this.need = need;
  }
}

/** An op's implementation: its arguments, parsed, to its result. */
export type Implementation = (args: never, ctx: OpContext) => unknown;

/** What a rule makes of a token's call: refused (saying why), a proposal for you, or nothing. */
export type RuleOutcome = { refuse: string } | { propose: NeedId } | undefined;

/** Checks a rule on a token's arguments, in the op's scope, before the op runs. */
export type RuleCheck = (
  args: never,
  call: { caller: TokenCaller; party: Party },
) => RuleOutcome | Promise<RuleOutcome>;

/**
 * What a dispatcher serves: each op's surface, schemas and implementation, and each rule checked on
 * arguments, its check on each op that carries it. A rule with none (checked only on the change an
 * op commits) isn't checked here.
 */
export interface Registry {
  readonly surface: Readonly<Record<string, Surface>>;
  readonly ops: Readonly<Record<string, OpDef>>;
  readonly implementations: Readonly<Record<string, Implementation>>;
  readonly rules: Readonly<Partial<Record<Rule, Readonly<Partial<Record<string, RuleCheck>>>>>>;
}

export interface DispatchOptions {
  /** Whether an agent is a lead now, as kept on this machine. Without it, none is. */
  isLead?: (canvas: CanvasId, agent: string) => boolean;
  /** How each kind of id is resolved against a token's reach. A kind with none is never reached. */
  resolvers?: Readonly<Partial<Record<Brand, Resolver>>>;
  /**
   * The canvases you have open: an op's canvas may be left out by a caller with exactly one canvas
   * (yours, an agent's own, or a token's only one). Without it, you have none.
   */
  openCanvases?: () => readonly CanvasId[];
  /**
   * Whether a canvas holds, for `caller`, an id unique across canvases (a message it sent or got,
   * by its id): a call that names it but no canvas, from a caller with several, goes to the one
   * canvas that does (`withdraw` takes no canvas). Without it, none does.
   */
  holds?: (canvas: CanvasId, ref: IdRef, caller: Caller) => boolean;
  /** Commits an op's change to a canvas's document (canvas/commit.ts). Without it, none can. */
  commit?: Committer;
  /**
   * Whether each call's arguments and result are checked to be plain data (as CoreLink checks
   * what crosses a port) and each result against its schema: in dev and tests.
   */
  check?: boolean;
  now?: () => number;
}

/** The core's operations, as every transport serves them. */
export interface Dispatcher {
  readonly surface: Readonly<Record<string, Surface>>;
  readonly ops: Readonly<Record<string, OpDef>>;
  /** The caller's party now. */
  partyOf(caller: Caller): Party;
  /** Calls op `name` with `raw` (what the caller sent) as `caller`: its result, or its error. */
  call(
    name: string,
    raw: unknown,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<OpResult<unknown>>;
}

/** An op's turn in its scope: its signal, what says it is past its point of no return, its revs. */
interface Turn {
  signal: AbortSignal;
  noReturn(): void;
  /** The revision of each topic its commits reached. */
  revs: Record<string, number>;
}

/** An op's arguments as a proposal of it keeps them: but its request and expect, its own. */
function kept(args: unknown): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([key]) => key !== 'request' && key !== 'expect',
    ),
  );
}

/** The kinds of id that name an agent, which an agent may not aim an op declared `self: refused` at. */
const AGENT_BRANDS: ReadonlySet<Brand> = new Set(['AgentId', 'NodeId', 'GroupId']);
/** The kinds of id unique across canvases (UUIDs a canvas mints), which say whose canvas a call is on. */
const UNIQUE_BRANDS: ReadonlySet<Brand> = new Set(['MessageId']);
/** How a refusal names a party that isn't in an op's audience. */
const PARTY_WORDS: Readonly<Record<Party, string>> = {
  you: 'You',
  lead: 'A lead',
  worker: 'An agent',
  'outside-read': 'A read-only token',
  'outside-write': 'A token',
};

export function createDispatcher(registry: Registry, options: DispatchOptions = {}): Dispatcher {
  const {
    isLead,
    resolvers = {},
    openCanvases = () => [],
    holds = () => false,
    commit,
    check = false,
    now = Date.now,
  } = options;
  const scopes = new Scopes();
  const throttle = new Throttle(now);
  const requests = new Requests();

  /** Op `name`'s surface, schemas and implementation, or throws not-found. */
  function opOf(name: string): [Surface, OpDef, Implementation] {
    const surface = Object.hasOwn(registry.surface, name) ? registry.surface[name] : undefined;
    const def = Object.hasOwn(registry.ops, name) ? registry.ops[name] : undefined;
    const implementation = Object.hasOwn(registry.implementations, name)
      ? registry.implementations[name]
      : undefined;
    if (!surface || !def || !implementation) {
      throw new OpFailure('not-found', `There is no operation named ${name}.`);
    }
    return [surface, def, implementation];
  }

  function parse(def: OpDef, raw: unknown): unknown {
    const fault = check ? notPlainData(raw, 'args') : undefined;
    if (fault) throw new OpFailure('invalid', `${fault}.`);
    const parsed = def.input.safeParse(raw === undefined ? {} : raw);
    if (!parsed.success)
      throw new OpFailure('invalid', `Invalid arguments${issueOf(parsed.error)}.`);
    const broken = brokenTextIn(parsed.data);
    if (broken !== undefined) {
      throw new OpFailure(
        'invalid',
        `Invalid arguments${at(broken)}: it holds a broken character (a lone surrogate).`,
      );
    }
    return parsed.data;
  }

  function checkResult(def: OpDef, value: unknown): void {
    const fault = notPlainData(value, 'result');
    if (fault) throw new OpFailure('unavailable', `${fault}.`);
    const parsed = def.output.safeParse(value);
    if (!parsed.success) {
      throw new OpFailure(
        'unavailable',
        `The result doesn’t fit its schema${issueOf(parsed.error)}.`,
      );
    }
  }

  /**
   * Throws unless every id a token's `args` for op `name` names is in its reach now, none aimed at
   * the agent itself where the op may not be: checked as the call comes, again in its scope, and
   * again as each of its commits builds (an inner op of a batch's too), since what a token reaches
   * may change while its call waits (a lead's agent moved out of its team). You reach everything.
   */
  function checkReach(
    name: string,
    surface: Surface,
    def: OpDef,
    args: unknown,
    caller: Caller,
  ): Party {
    const party = audience(name, surface, caller);
    if (caller.kind === 'human') return party;
    const reach = surface.access[party];
    if (reach === undefined)
      throw new OpFailure('forbidden', `${PARTY_WORDS[party]} can’t call ${name}.`);
    const ids = idsIn(def.input, args);
    const missing = outOfReach(ids, caller, reach, resolvers);
    if (missing) throw new OpFailure('not-found', missing);
    if (surface.self === 'refused' && aimsAtItself(ids, caller)) {
      throw new OpFailure('refused', `An agent can’t call ${name} on itself.`);
    }
    return party;
  }

  /** The caller's party and audience now, including calls that waited in a scope or a build. */
  function audience(name: string, surface: Surface, caller: Caller): Party {
    const party = partyOf(caller, isLead);
    if (surface.access[party] === undefined) {
      throw party !== 'you' && Object.keys(surface.access).every((p) => p === 'you')
        ? new OpFailure('human-only', `Only the user can call ${name}, in corrallm’s window.`)
        : new OpFailure('forbidden', `${PARTY_WORDS[party]} can’t call ${name}.`);
    }
    return party;
  }

  /**
   * The op's rules on a token's arguments, in its scope: throws for one that refuses them; the
   * proposal a rule made of them, if one did; else nothing.
   */
  async function checkRules(
    name: string,
    surface: Surface,
    args: unknown,
    caller: TokenCaller,
    party: Party,
  ): Promise<NeedId | undefined> {
    for (const rule of surface.rules ?? []) {
      const checks = registry.rules[rule];
      // A rule with no checks is checked on the change an op commits, if anywhere.
      if (checks === undefined) continue;
      const checkRule = Object.hasOwn(checks, name) ? checks[name] : undefined;
      if (!checkRule) {
        throw new OpFailure('refused', `No check is kept for the rule ${rule} on ${name}.`);
      }
      const outcome = await checkRule(args as never, { caller, party });
      if (outcome && 'refuse' in outcome) throw new OpFailure('refused', outcome.refuse);
      if (outcome) return outcome.propose;
    }
    return undefined;
  }

  /**
   * `raw` as op `name` takes it from `caller` within another op: its audience checked, parsed,
   * and, for a token, every id it names in reach, none aimed at itself where it may not be.
   */
  function admit(
    name: string,
    [surface, def]: [Surface, OpDef, Implementation],
    raw: unknown,
    caller: Caller,
  ): unknown {
    audience(name, surface, caller);
    const args = parse(def, raw);
    checkReach(name, surface, def, args, caller);
    return args;
  }

  /**
   * Runs op `name`'s implementation with its parsed `args`, its rules checked, in a turn its own
   * or the op's it is part of: its result, or `{ proposed }` if a rule made it a proposal for you.
   */
  async function run(
    name: string,
    [surface, def, implementation]: [Surface, OpDef, Implementation],
    args: unknown,
    caller: Caller,
    turn: Turn,
    options: CommitOptions = {},
  ): Promise<unknown> {
    const party = checkReach(name, surface, def, args, caller);
    if (caller.kind !== 'human') {
      const proposed = await checkRules(name, surface, args, caller, party);
      checkReach(name, surface, def, args, caller);
      if (proposed !== undefined) return { proposed };
    }
    const by = partyIdOf(caller);
    const { request, expect = options.expect } = args as {
      request?: string;
      expect?: Readonly<Record<string, number>>;
    };
    const proposes = surface.rules?.some((rule) => PROPOSING_RULES.includes(rule)) === true;
    const ctx: OpContext = {
      caller,
      get party() {
        return partyOf(caller, isLead);
      },
      by,
      ...(options.proposedBy === undefined ? {} : { proposedBy: options.proposedBy }),
      signal: turn.signal,
      noReturn: () => {
        turn.noReturn();
      },
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.guard === undefined ? {} : { guard: options.guard }),
      commit: async (canvas, build) => {
        if (commit === undefined) {
          throw new OpFailure('unavailable', 'This core keeps no canvas’s document.');
        }
        if (canvas === undefined) {
          throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
        }
        const done = await commit(
          canvas as CanvasId,
          (document) => {
            // In the canvas's turn: what the caller reaches may have changed while it waited.
            checkReach(name, surface, def, args, caller);
            return build(document);
          },
          {
            op: name,
            caller,
            get party() {
              return partyOf(caller, isLead);
            },
            by,
            ...(request === undefined ? {} : { request }),
            ...(expect === undefined ? {} : { expect }),
            ...(options.unchanged === undefined ? {} : { unchanged: options.unchanged }),
            signal: turn.signal,
            noReturn: () => {
              turn.noReturn();
            },
            proposes,
            args: kept(args),
            ...(options.proposedBy === undefined ? {} : { proposedBy: options.proposedBy }),
            ...(options.within === undefined ? {} : { within: options.within }),
          },
        );
        if ('proposed' in done) throw new ProposedInstead(done.proposed);
        if (done.rev !== undefined) turn.revs[`canvas:${canvas}`] = done.rev;
        return done.result;
      },
      reached: (canvas, rev) => {
        turn.revs[`canvas:${canvas}`] = rev;
      },
      call: (sub, raw, more) => {
        const op = opOf(sub);
        const parsed = admit(sub, op, raw, caller);
        return scopes.draining(
          scopeOf(op[0], parsed),
          drainsOf(op[0], parsed, registry.surface),
          turn.signal,
          () => run(sub, op, parsed, caller, turn, more),
        );
      },
      prepare: async (sub, raw) => {
        const op = opOf(sub);
        const [inner, innerDef, build] = op;
        if (inner.kind !== 'doc') {
          throw new OpFailure('invalid', `${sub} isn’t an edit of a canvas’s document.`);
        }
        const parsed = admit(sub, op, raw, caller);
        if (caller.kind !== 'human') {
          const proposed = await checkRules(sub, inner, parsed, caller, partyOf(caller, isLead));
          checkReach(sub, inner, innerDef, parsed, caller);
          if (proposed)
            throw new OpFailure('refused', `${sub} can’t come to the user as a proposal here.`);
        }
        let captured: ((document: CanvasDocument) => Built<unknown>) | undefined;
        const capture: OpContext = {
          ...ctx,
          get party() {
            return partyOf(caller, isLead);
          },
          commit: (_canvas, made) => {
            if (captured !== undefined) throw new Error(`${sub} commits more than once.`);
            captured = made;
            // Its result is the build's, which the op that prepared it commits.
            return new Promise(() => undefined);
          },
          call: () => Promise.reject(new Error(`${sub} runs no other op.`)),
          prepare: () => Promise.reject(new Error(`${sub} prepares no other op.`)),
        };
        const returned = Promise.resolve(build(parsed as never, capture));
        if (captured === undefined) {
          await returned;
          throw new OpFailure('invalid', `${sub} can’t be made as part of another edit.`);
        }
        void returned.catch(() => undefined);
        const made = captured;
        // Built in the commit's turn of the op that prepared it: what the caller reaches then.
        return (document) => {
          checkReach(sub, inner, innerDef, parsed, caller);
          return made(document);
        };
      },
    };
    try {
      return await implementation(args as never, ctx);
    } catch (error) {
      if (error instanceof ProposedInstead) return { proposed: error.need };
      throw error;
    }
  }

  /**
   * Runs the op in its scope, once a token's rules are checked there (they read what the ops before
   * it in its scope left): its result, kept for a repeat of its request unless the op failed for
   * being cancelled (its caller left, a preempting op stopped it) or with what nobody expected,
   * which applied nothing a retry can count on.
   */
  async function apply(
    name: string,
    op: [Surface, OpDef, Implementation],
    args: unknown,
    caller: Caller,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const [surface, def] = op;
    /** The signal the op ran with, once it runs: aborted if it was superseded or its caller left. */
    let ran: AbortSignal | undefined;
    try {
      const value = await scopes.run(
        scopeOf(surface, args),
        {
          preempt: surface.preempt === true,
          drains: drainsOf(surface, args, registry.surface),
        },
        signal,
        async (opSignal, noReturn) => {
          ran = opSignal;
          /** The revision of each topic the op reached. */
          const revs: Record<string, number> = {};
          // run checks reach and the caller's current party here, once its scope is entered.
          const result = await run(name, op, args, caller, {
            signal: opSignal,
            noReturn,
            revs,
          });
          // A write says what it reached: the revisions of the topics it changed.
          return surface.kind === 'read' || isProposal(result)
            ? result
            : { ...(result as object), revs };
        },
      );
      if (check) checkResult(def, value);
      return { result: { ok: true, value }, kept: true };
    } catch (error) {
      const cancelled = signal?.aborted === true || ran?.aborted === true;
      return {
        result: { ok: false, error: errorOf(error, signal) },
        kept: error instanceof OpFailure && !cancelled,
      };
    }
  }

  async function call(
    name: string,
    raw: unknown,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<OpResult<unknown>> {
    let release: (() => void) | undefined;
    try {
      const op = opOf(name);
      const [surface, def] = op;
      audience(name, surface, caller);
      if (caller.kind !== 'human') {
        const admitted = throttle.admit(callerKey(caller), {
          write: surface.kind !== 'read',
          waits: surface.waits === true,
        });
        if (admitted === 'calls') throw new OpFailure('refused', 'Too many calls; slow down.');
        if (admitted === 'waits') throw new OpFailure('refused', TOO_MANY_WAITS);
        release = admitted;
      }
      const args = parse(def, withCanvas(def, raw, caller, openCanvases, holds));
      // A caller's own repeated request is answered before reach is resolved: what its first call
      // did (a delete) may have put what it names out of reach. One that runs is checked first.
      const run = async (): Promise<Attempt> => {
        try {
          checkReach(name, surface, def, args, caller);
        } catch (error) {
          return { result: { ok: false, error: errorOf(error, signal) }, kept: false };
        }
        return apply(name, op, args, caller, signal);
      };
      const { request } = args as { request?: unknown };
      const result =
        typeof request === 'string'
          ? await requests.remembered(callerKey(caller), `${name}|${request}|${keyOf(args)}`, run)
          : (await run()).result;
      // Current rows are disclosed only while the caller still reaches them, even in a cached
      // refusal. Successful deletes keep their first result after their targets have gone.
      if (!result.ok && result.error.current !== undefined)
        checkReach(name, surface, def, args, caller);
      return result;
    } catch (error) {
      return { ok: false, error: errorOf(error, signal) };
    } finally {
      release?.();
    }
  }

  return {
    surface: registry.surface,
    ops: registry.ops,
    partyOf: (caller) => partyOf(caller, isLead),
    call,
  };
}

/**
 * The scope an op runs in, from the canvas and agent its arguments name (null: none). An op aimed
 * at a group runs in its canvas's scope, which holds every member's.
 */
export function scopeOf(surface: Pick<Surface, 'scope'>, args: unknown): string[] | null {
  const { canvas, agent, to, target } = args as {
    canvas?: unknown;
    agent?: unknown;
    to?: unknown;
    target?: { agent?: unknown; group?: unknown };
  };
  switch (surface.scope) {
    case 'none':
      return null;
    case 'app':
      return ['app'];
    case 'canvas':
      return ['app', String(canvas)];
    case 'agent':
      return target?.group !== undefined
        ? ['app', String(canvas)]
        : ['app', String(canvas), String(agent ?? to ?? target?.agent)];
  }
}

/**
 * The scopes an op drains as it comes, from its arguments: every scope beneath its canvas's (in the
 * app's scope, the canvas it replaces, `replace`, if it replaces one), or those of the agents it
 * removes or switches (`agent`, `nodes`), and those its inner ops would (a batch's `ops`, by their
 * surfaces in `surfaces`).
 */
export function drainsOf(
  surface: Pick<Surface, 'scope' | 'drains'>,
  args: unknown,
  surfaces: Readonly<Record<string, Pick<Surface, 'scope' | 'drains'>>> = {},
): string[][] {
  const {
    canvas,
    replace,
    agent,
    nodes = [],
    ops = [],
  } = args as {
    canvas?: string;
    replace?: { canvas?: string };
    agent?: string;
    nodes?: readonly string[];
    ops?: readonly { op: string; args: object }[];
  };
  if (surface.drains === 'canvas') {
    const drained = surface.scope === 'app' ? replace?.canvas : canvas;
    return drained === undefined ? [] : [['app', drained]];
  }
  if (surface.drains === undefined) return [];
  return [
    ...[...(agent === undefined ? [] : [agent]), ...nodes].map((one) => [
      'app',
      String(canvas),
      one,
    ]),
    ...ops.flatMap(({ op, args: inner }) => {
      const drains = Object.hasOwn(surfaces, op) ? surfaces[op] : undefined;
      return drains?.drains === 'agents' ? drainsOf(drains, { ...inner, canvas }, surfaces) : [];
    }),
  ];
}

/**
 * `raw` with its canvas filled in where the op takes one, the caller left it out, and the caller
 * has exactly one: an agent's own, an outside token's only one, or the only one you have open; or,
 * for a caller with several, the one that `holds` the ids it names that are unique across canvases
 * (a message's), if one alone does. Arguments that fit no canvas go back to parse for their schema
 * error. Otherwise a caller with several is asked to name one, before any id it names is looked
 * for in its reach (which, with no canvas, would find none, as if the agent it named weren't there).
 */
function withCanvas(
  def: OpDef,
  raw: unknown,
  caller: Caller,
  openCanvases: () => readonly CanvasId[],
  holds: (canvas: CanvasId, ref: IdRef, caller: Caller) => boolean,
): unknown {
  const shape = (def.input as { shape?: Record<string, unknown> }).shape;
  const given = raw === undefined ? {} : raw;
  if (
    shape === undefined ||
    !('canvas' in shape) ||
    typeof given !== 'object' ||
    given === null ||
    Array.isArray(given) ||
    'canvas' in given
  ) {
    return raw;
  }
  const canvases = caller.kind === 'human' ? openCanvases() : canvasesOf(caller);
  if (canvases.length > 1) {
    let valid = false;
    const holding: CanvasId[] = [];
    for (const canvas of canvases) {
      const parsed = def.input.safeParse({ ...given, canvas });
      if (!parsed.success) continue;
      valid = true;
      const unique = idsIn(def.input, parsed.data).filter((ref) => UNIQUE_BRANDS.has(ref.brand));
      if (unique.length > 0 && unique.every((ref) => holds(canvas, ref, caller)))
        holding.push(canvas);
    }
    if (!valid) return { ...given, canvas: canvases[0] };
    if (holding.length === 1) return { ...given, canvas: holding[0] };
    throw new OpFailure(
      'invalid',
      `Name the canvas: there is more than one to choose from (${canvases.join(', ')}).`,
    );
  }
  const [only] = canvases;
  return only === undefined ? raw : { ...given, canvas: only };
}

/**
 * A call's parsed arguments, as the SHA-256 of their JSON with each object's keys in order: equal
 * for two calls of the same arguments, however their keys were sent, and short however large they
 * are (a batch's).
 */
function keyOf(args: unknown): string {
  const json = JSON.stringify(args, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0)),
        )
      : value,
  );
  return createHash('sha256').update(json).digest('base64url');
}

/** Whether an op's result is a proposal for you, which applied nothing. */
function isProposal(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'proposed' in result;
}

/** Whether an agent's call names the agent itself. */
function aimsAtItself(ids: readonly IdRef[], caller: TokenCaller): boolean {
  return (
    caller.kind === 'agent' &&
    ids.some((ref) => AGENT_BRANDS.has(ref.brand) && ref.id === caller.agent)
  );
}

/** A schema's first complaint, as the end of a sentence: " (body): Too big…". */
function issueOf(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) return '';
  return `${at(issue.path)}: ${issue.message}`;
}

/** Where in arguments a path leads, as a sentence says it: " (labels.lead)", or nothing at the top. */
function at(path: readonly PropertyKey[]): string {
  const joined = path.map(String).join('.');
  return joined === '' ? '' : ` (${joined})`;
}

/**
 * The path to text with a broken character (a lone surrogate) in `value`, parsed arguments: a
 * string, or a key, named by what holds it. Undefined if it holds none.
 */
function brokenTextIn(value: unknown, path: readonly string[] = []): string[] | undefined {
  if (typeof value === 'string') return value.isWellFormed() ? undefined : [...path];
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, one] of Object.entries(value)) {
    if (!key.isWellFormed()) return [...path];
    const found = brokenTextIn(one, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What a failure answers as. */
function errorOf(error: unknown, signal: AbortSignal | undefined): OpError {
  if (error instanceof OpFailure) {
    return {
      code: error.code,
      sentence: error.message,
      ...(error.current === undefined ? {} : { current: error.current }),
    };
  }
  if (error instanceof UnreadableIds) return { code: 'not-found', sentence: error.message };
  if (error instanceof Superseded) return { code: 'refused', sentence: error.message };
  if (signal?.aborted) return { code: 'refused', sentence: 'The call was cancelled.' };
  return { code: 'unavailable', sentence: error instanceof Error ? error.message : String(error) };
}
