import type { z } from 'zod';

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
 * several to name one if its arguments otherwise fit, parses them with the op's one schema,
 * resolves every id a token names against its reach, refuses an agent aiming at itself an op it
 * may not, returns a repeated request's first result, and runs the op in its scope, checking the
 * op's rules on a token's arguments there first (a met rule refuses it, or makes it a proposal for
 * you), since they read what the ops before it in its scope left. It never throws: a failure is a
 * value, whose code survives any transport.
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
 * What an op is called with besides its arguments: who called, as what party, its signal, and how
 * it changes a canvas's document.
 */
export interface OpContext {
  readonly caller: Caller;
  readonly party: Party;
  /** The party the caller is: what each change it commits is stamped with. */
  readonly by: PartyId;
  /** Aborts when a preempting op supersedes it, or its caller gives up: then it unwinds. */
  readonly signal: AbortSignal;
  /**
   * Commits to canvas `canvas`'s document (the canvas the op names) what `build` makes of it,
   * purely, from the live one (B9 Design §3): checked against the revisions the call expects and,
   * for a token, the change rules, then written past the call's point of no return. Resolves with
   * the op's result once it is on disk, the revision it took the call's (`revs`); rejects, changing
   * nothing, if the canvas isn't open, an entity the call expects is at another revision (a
   * conflict, saying what each is now), a change rule refuses it, or it couldn't be written.
   */
  commit<R>(canvas: string | undefined, build: (document: CanvasDocument) => Built<R>): Promise<R>;
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
   * Runs the op in its scope, once a token's rules are checked there (they read what the ops before
   * it in its scope left): its result, kept for a repeat of its request unless the op failed for
   * being cancelled (its caller left, a preempting op stopped it) or with what nobody expected,
   * which applied nothing a retry can count on.
   */
  async function apply(
    name: string,
    [surface, def, implementation]: [Surface, OpDef, Implementation],
    args: unknown,
    caller: Caller,
    party: Party,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    /** The signal the op ran with, once it runs: aborted if it was superseded or its caller left. */
    let ran: AbortSignal | undefined;
    try {
      const value = await scopes.run(
        scopeOf(surface, args),
        { preempt: surface.preempt === true, drains: drainsOf(surface, args) },
        signal,
        async (opSignal, noReturn) => {
          ran = opSignal;
          if (caller.kind !== 'human') {
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
              if (outcome) return { proposed: outcome.propose };
            }
          }
          const by = partyIdOf(caller);
          const { request, expect } = args as {
            request?: string;
            expect?: Readonly<Record<string, number>>;
          };
          /** The revision of each topic the op reached. */
          const revs: Record<string, number> = {};
          const result = await implementation(args as never, {
            caller,
            party,
            by,
            signal: opSignal,
            commit: async (canvas, build) => {
              if (commit === undefined) {
                throw new OpFailure('unavailable', 'This core keeps no canvas’s document.');
              }
              if (canvas === undefined) {
                throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
              }
              const done = await commit(canvas as CanvasId, build, {
                op: name,
                caller,
                party,
                by,
                ...(request === undefined ? {} : { request }),
                ...(expect === undefined ? {} : { expect }),
                signal: opSignal,
                noReturn,
              });
              if (done.rev !== undefined) revs[`canvas:${canvas}`] = done.rev;
              return done.result;
            },
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
      const party = partyOf(caller, isLead);
      // The audience, on every call (decision 2).
      const reach = party === 'you' ? surface.access.you : surface.access[party];
      if (reach === undefined) {
        throw party !== 'you' && Object.keys(surface.access).every((p) => p === 'you')
          ? new OpFailure('human-only', `Only the user can call ${name}, in corrallm’s window.`)
          : new OpFailure('forbidden', `${PARTY_WORDS[party]} can’t call ${name}.`);
      }
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
      if (caller.kind !== 'human') {
        const ids = idsIn(def.input, args);
        const missing = outOfReach(ids, caller, reach, resolvers);
        if (missing) throw new OpFailure('not-found', missing);
        if (surface.self === 'refused' && aimsAtItself(ids, caller)) {
          throw new OpFailure('refused', `An agent can’t call ${name} on itself.`);
        }
      }
      const run = () => apply(name, op, args, caller, party, signal);
      const { request } = args as { request?: unknown };
      return typeof request === 'string'
        ? await requests.remembered(callerKey(caller), `${name}|${request}`, run)
        : (await run()).result;
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
 * The scopes an op drains as it comes, from its arguments: every scope beneath its canvas's, or
 * those of the agents it removes or switches (`agent`, `nodes`).
 */
export function drainsOf(surface: Pick<Surface, 'drains'>, args: unknown): string[][] {
  const {
    canvas,
    agent,
    nodes = [],
  } = args as {
    canvas?: unknown;
    agent?: string;
    nodes?: readonly string[];
  };
  if (surface.drains === 'canvas') return [['app', String(canvas)]];
  if (surface.drains === undefined) return [];
  return [...(agent === undefined ? [] : [agent]), ...nodes].map((one) => [
    'app',
    String(canvas),
    one,
  ]);
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
  const path = issue.path.map(String).join('.');
  return `${path === '' ? '' : ` (${path})`}: ${issue.message}`;
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
