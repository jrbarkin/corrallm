import type { Party } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
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

/** You, at a window (or main's own native UI: 'host'). Made only by `asHuman`. */
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
 * `outside:<name>`), what it may do, and the canvases it reaches, by their stable ids.
 */
export interface OutsideCaller {
  readonly kind: 'outside';
  readonly token: string;
  readonly name: string;
  readonly access: 'read' | 'write';
  readonly canvases: readonly CanvasId[];
}

export type Caller = HumanCaller | AgentCaller | OutsideCaller;

/** A caller a token or a session's pipe identifies: never you. */
export type TokenCaller = AgentCaller | OutsideCaller;

/**
 * You, at `window`. Only the core's side of a window's port calls this (core/gui.ts, B8), for a
 * port main made after its sender check: never for anything a token, a page or an agent sends.
 */
export function asHuman(window: WindowId | 'host'): HumanCaller {
  return { kind: 'human', window } as HumanCaller;
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
