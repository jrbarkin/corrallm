import type { z } from 'zod';

import type { OpDef } from '../../shared/api/define';
import type { OpError, OpErrorCode, OpResult } from '../../shared/api/errors';
import { idsIn } from '../../shared/api/ids';
import type { Brand, IdRef, NeedId } from '../../shared/api/ids';
import type { Party, Rule, Surface } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { callerKey, partyOf } from './caller';
import type { Caller, TokenCaller } from './caller';
import { notPlainData } from './link';
import { outOfReach } from './reach';
import type { Resolver } from './reach';
import { Scopes, Superseded } from './scopes';
import { Throttle } from './throttle';

/*
 * core.call: the one dispatcher every transport calls (Core Server §3.1), a window's port and MCP
 * alike, so that no transport adds or skips anything. On every call, in this order, it checks the
 * caller's party against the op's audience (decision 2: a tool missing from a party's list is
 * refused when called anyway), admits a token's call within its limits, parses the arguments with
 * the op's one schema, resolves every id a token names against its reach, refuses an agent aiming
 * at itself an op it may not, checks the op's rules on a token's arguments (a met rule refuses it,
 * or makes it a proposal for you), returns a repeated request's first result, and runs the op in
 * its scope. It never throws: a failure is a value, whose code survives any transport.
 */

/** An operation's failure, thrown by core.call's checks and by ops; it answers as a value. */
export class OpFailure extends Error {
  readonly code: OpErrorCode;

  constructor(code: OpErrorCode, sentence: string) {
    super(sentence);
    this.name = 'OpFailure';
    this.code = code;
  }
}

/** What an op is called with besides its arguments: who called, as what party, and its signal. */
export interface OpContext {
  readonly caller: Caller;
  readonly party: Party;
  /** Aborts when a preempting op supersedes it, or its caller gives up: then it unwinds. */
  readonly signal: AbortSignal;
}

/** An op's implementation: its arguments, parsed, to its result. */
export type Implementation = (args: never, ctx: OpContext) => unknown;

/** What a rule makes of a token's call: refused (saying why), a proposal for you, or nothing. */
export type RuleOutcome = { refuse: string } | { propose: NeedId } | undefined;

/** Checks a rule on a token's arguments, before the op runs. */
export type RuleCheck = (
  args: never,
  call: { caller: TokenCaller; party: Party },
) => RuleOutcome | Promise<RuleOutcome>;

/** What a dispatcher serves: each op's surface, schemas and implementation, and the rules' checks. */
export interface Registry {
  readonly surface: Readonly<Record<string, Surface>>;
  readonly ops: Readonly<Record<string, OpDef>>;
  readonly implementations: Readonly<Record<string, Implementation>>;
  readonly rules: Readonly<Partial<Record<Rule, RuleCheck>>>;
}

export interface DispatchOptions {
  /** Whether an agent is a lead now, as kept on this machine. Without it, none is. */
  isLead?: (canvas: CanvasId, agent: string) => boolean;
  /** How each kind of id is resolved against a token's reach. A kind with none is never reached. */
  resolvers?: Readonly<Partial<Record<Brand, Resolver>>>;
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

/** How many recent requests' results are kept, for a repeated call. */
const REMEMBERED_REQUESTS = 1000;
/** The kinds of id that name an agent, which an agent may not aim an op declared `self: refused` at. */
const AGENT_BRANDS: ReadonlySet<Brand> = new Set(['AgentId', 'NodeId']);
/** How a refusal names a party that isn't in an op's audience. */
const PARTY_WORDS: Readonly<Record<Party, string>> = {
  you: 'You',
  lead: 'A lead',
  worker: 'An agent',
  'outside-read': 'A read-only token',
  'outside-write': 'A token',
};

export function createDispatcher(registry: Registry, options: DispatchOptions = {}): Dispatcher {
  const { isLead, resolvers = {}, check = false, now = Date.now } = options;
  const scopes = new Scopes();
  const throttle = new Throttle(now);
  const requests = new Map<string, Promise<OpResult<unknown>>>();

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

  /** Returns a repeated request's first result, or runs it and keeps its result a while. */
  function remembered(
    key: string,
    run: () => Promise<OpResult<unknown>>,
  ): Promise<OpResult<unknown>> {
    const known = requests.get(key);
    if (known) return known;
    const result = run();
    requests.set(key, result);
    const oldest = requests.size > REMEMBERED_REQUESTS ? requests.keys().next().value : undefined;
    if (oldest !== undefined) requests.delete(oldest);
    return result;
  }

  /** Checks a token's rules, then runs the op in its scope. */
  async function apply(
    [surface, def, implementation]: [Surface, OpDef, Implementation],
    args: unknown,
    caller: Caller,
    party: Party,
    signal: AbortSignal | undefined,
  ): Promise<OpResult<unknown>> {
    try {
      if (caller.kind !== 'human') {
        for (const rule of surface.rules ?? []) {
          const checkRule = registry.rules[rule];
          if (!checkRule) throw new OpFailure('refused', `No check is kept for the rule ${rule}.`);
          const outcome = await checkRule(args as never, { caller, party });
          if (outcome && 'refuse' in outcome) throw new OpFailure('refused', outcome.refuse);
          if (outcome) return { ok: true, value: { proposed: outcome.propose } };
        }
      }
      const value = await scopes.run(
        scopeOf(surface, args),
        surface.preempt === true,
        signal,
        (opSignal) =>
          Promise.resolve(implementation(args as never, { caller, party, signal: opSignal })),
      );
      if (check) checkResult(def, value);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorOf(error, signal) };
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
          ? new OpFailure('human-only', `Only you can call ${name}, in corrallm’s window.`)
          : new OpFailure('forbidden', `${PARTY_WORDS[party]} can’t call ${name}.`);
      }
      if (caller.kind !== 'human') {
        release = throttle.admit(callerKey(caller), surface.kind !== 'read');
        if (!release) throw new OpFailure('refused', 'Too many calls; slow down.');
      }
      const args = parse(def, raw);
      if (caller.kind !== 'human') {
        const ids = idsIn(def.input, args);
        const missing = outOfReach(ids, caller, reach, resolvers);
        if (missing) throw new OpFailure('not-found', missing);
        if (surface.self === 'refused' && aimsAtItself(ids, caller)) {
          throw new OpFailure('refused', `An agent can’t call ${name} on itself.`);
        }
      }
      const run = () => apply(op, args, caller, party, signal);
      const { request } = args as { request?: unknown };
      return await (typeof request === 'string'
        ? remembered(`${callerKey(caller)}|${name}|${request}`, run)
        : run());
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

/** The scope an op runs in, from the canvas and agent its arguments name (null: none). */
function scopeOf(surface: Surface, args: unknown): string[] | null {
  const { canvas, agent, to } = args as { canvas?: unknown; agent?: unknown; to?: unknown };
  switch (surface.scope) {
    case 'none':
      return null;
    case 'app':
      return ['app'];
    case 'canvas':
      return ['app', String(canvas)];
    case 'agent':
      return ['app', String(canvas), String(agent ?? to)];
  }
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
  if (error instanceof OpFailure) return { code: error.code, sentence: error.message };
  if (error instanceof Superseded) return { code: 'refused', sentence: error.message };
  if (signal?.aborted) return { code: 'refused', sentence: 'The call was cancelled.' };
  return { code: 'unavailable', sentence: error instanceof Error ? error.message : String(error) };
}
