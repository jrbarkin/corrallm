import type { Party } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { PartyId } from '../../shared/model/messages';
import type { PromptReader } from '../../shared/model/prompt-views';
import type { WindowId } from './host';

/*
 * Who calls an operation (Core Server §6.1). You come only over a window's port, which main hands
 * the core after its sender check, or from main's own native UI (the quit dialog, Pause all): no
 * token is ever you (decision 7). An agent comes with its session's token, or over the pipe of a
 * session corrallm runs; an outside orchestrator with the token a person made for it. A caller's
 * party is read on every call, never fixed when its token is made: lead status is kept on this
 * machine, and taking it away refuses the agent's next lead call at once.
 */

declare const human: unique symbol;

/**
 * You, at a window (or main's own native UI: 'host'). Made only by core/gui.ts, for a window's port
 * main made after its sender check.
 */
export interface HumanCaller {
  readonly kind: 'human';
  readonly window: WindowId | 'host';
  readonly [human]: true;
}

/** An agent corrallm runs: its session, on its canvas. */
export interface AgentCaller {
  readonly kind: 'agent';
  readonly canvas: CanvasId;
  readonly agent: string;
  readonly session: string;
}

/**
 * An orchestrator outside corrallm, by the token a person made: its name (its party is
 * `outside:<name>`), what it may do, and the canvases it reaches, by their stable ids. `merge` is
 * whether it may merge an agent's branch (B9b §9 C1, Q30): a read-write token made with
 * `--no-merge` is a writer (`outside-write`) that may not; a read-only one never may.
 */
export interface OutsideCaller {
  readonly kind: 'outside';
  readonly token: string;
  readonly name: string;
  readonly access: 'read' | 'write';
  readonly merge: boolean;
  readonly canvases: readonly CanvasId[];
}

export type Caller = HumanCaller | AgentCaller | OutsideCaller;

/** A caller a token or a session's pipe identifies: never you. */
export type TokenCaller = AgentCaller | OutsideCaller;

/** Whether `caller` is one a token or a session's pipe identifies, as any but you is. */
export function isTokenCaller(caller: Caller): caller is TokenCaller {
  return caller.kind !== 'human';
}

/** The caller's party now: an agent is a lead only while `isLead` says so (none is by default). */
export function partyOf(
  caller: Caller,
  isLead?: (canvas: CanvasId, agent: string) => boolean,
): Party {
  switch (caller.kind) {
    case 'human':
      return 'you';
    case 'agent':
      return isLead?.(caller.canvas, caller.agent) ? 'lead' : 'worker';
    case 'outside':
      return caller.access === 'write' ? 'outside-write' : 'outside-read';
  }
}

/** What a caller's limits and repeated requests are kept by: its window, session or token. */
export function callerKey(caller: Caller): string {
  switch (caller.kind) {
    case 'human':
      return `window:${String(caller.window)}`;
    case 'agent':
      return `session:${caller.session}`;
    case 'outside':
      return `token:${caller.token}`;
  }
}

/**
 * Who a caller is among a canvas's parties (API Spec §5.1), as its messages and the holds it sets
 * are stamped: you, an agent by its id, or an outside orchestrator by its token's name. A token
 * made with a live token's name is the same party.
 */
export function partyIdOf(caller: Caller): PartyId {
  switch (caller.kind) {
    case 'human':
      return 'you';
    case 'agent':
      return `agent:${caller.agent}`;
    case 'outside':
      return `outside:${caller.name}`;
  }
}

/**
 * Who reads a prompt, as the one selector of what each reader sees of one (B13 C11) knows them:
 * you, or any token (whose reach each read boundary decides first). No token is ever you.
 */
export function promptReaderOf(caller: Caller): PromptReader {
  return caller.kind === 'human' ? 'you' : 'token';
}

/** The canvases a token caller has: an agent its own, an outside orchestrator those it was granted. */
export function canvasesOf(caller: TokenCaller): readonly CanvasId[] {
  return caller.kind === 'agent' ? [caller.canvas] : caller.canvases;
}
