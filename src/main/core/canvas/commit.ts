import type { AdapterId, Catalog } from '../../../shared/adapter';
import type { Current } from '../../../shared/api/errors';
import type { NeedId } from '../../../shared/api/ids';
import type { Party, Rule } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { diffRows, META, rowsFault } from '../../../shared/model/rows';
import { editFault } from '../../../shared/model/valid';
import { OpFailure } from '../call';
import type { Caller, TokenCaller } from '../caller';
import type { Staged } from '../delivery/messages';
import { changeSetOf } from './change';
import type { ChangeSet } from './change';
import type { Built, Documents, LiveDocument } from './documents';

/*
 * An op's commit to a canvas's document (B9 Design §3), what ctx.commit does: in the canvas's turn,
 * what the op builds over the live document, unless its call was superseded meanwhile, is checked
 * against the revisions its caller expects of entities (a conflict, saying what each is now, if
 * any has another), and, for a token, against every change rule (Core Server §3.6: whatever op made
 * the change, refused if any rule says so); then, past its point of no return, written
 * write-through (canvas/documents.ts). An op that changes nothing is checked against nothing. What
 * follows a commit (`committed`: the canvas's engine following its document) runs once it is on
 * disk, and never for one that failed (CommitFailed), which kept nothing.
 *
 * A rule may say a token's change is yours to decide rather than refuse it (R4: it deletes an
 * agent). Refusals win (so Allow never applies what a rule refused): only a change no rule refuses
 * becomes a proposal, and only for an op that declares a proposing rule, whose result may be one
 * (`proposes`); for any other op it is refused. A proposal applies nothing: it is raised for you
 * (`propose`: canvas/proposals.ts) with the change, and the call's result is its id.
 */

/**
 * Checks a change rule on a token's change: refuses it, saying why; makes it a proposal for you,
 * saying, with no stop at its end, why only you may make it (which refuses it where it can't be
 * one); or lets it be.
 */
export type ChangeRule = (
  change: ChangeSet,
  call: { caller: TokenCaller; party: Party },
) => { refuse: string } | { propose: string } | undefined;

/** The call a commit is made in: its op, its caller, what it carries, and its turn. */
export interface CommitCall {
  op: string;
  caller: Caller;
  party: Party;
  by: PartyId;
  /** The call's request id, kept with its revision. */
  request?: string;
  /** The revisions its caller expects of entities of the document, by their keys. */
  expect?: Readonly<Record<string, number>>;
  /** Aborts when the call is superseded or its caller gives up: before its point of no return. */
  signal: AbortSignal;
  /** Says the call is past its point of no return: nothing aborts it then. */
  noReturn(): void;
  /** Whether its op may come to you as a proposal (it declares R4 or R5), and its arguments. */
  proposes?: boolean;
  args?: Readonly<Record<string, unknown>>;
  /** The party whose proposal you allowed, which the revision records. */
  proposedBy?: PartyId;
  /** What else its write holds (a proposal's settlement and its record): canvas/documents.ts. */
  within?: () => Staged;
}

/**
 * Commits what `build` makes of canvas `canvas`'s document in `call`: the result, and its revision;
 * or, for a token's change only you may make, the proposal raised for you instead.
 */
export type Committer = <R>(
  canvas: CanvasId,
  build: (document: CanvasDocument) => Built<R>,
  call: CommitCall,
) => Promise<{ result: R; rev?: number } | { proposed: NeedId }>;

export interface CommitterDeps {
  documents: Pick<Documents, 'change'>;
  /** The change rules a token's commit is checked against, by rule. */
  rules: Readonly<Partial<Record<Rule, ChangeRule>>>;
  /** What follows a commit, once it is on disk. */
  committed?: (canvas: CanvasId, change: ChangeSet) => void;
  /**
   * Raises a proposal for you of a token's change only you may make, made in `call`: its id, once
   * it is kept. Without it, such a change is refused.
   */
  propose?: (canvas: CanvasId, change: ChangeSet, call: CommitCall) => Promise<NeedId>;
}

/** Thrown in a change's check when it is yours to decide: it carries the change to propose. */
class Proposing extends Error {
  readonly change: ChangeSet;
  constructor(change: ChangeSet, why: string) {
    super(why);
    this.name = 'Proposing';
    this.change = change;
  }
}

export function committer({ documents, rules, committed, propose }: CommitterDeps): Committer {
  return async (canvas, build, call) => {
    const { caller, party, signal } = call;
    let changed;
    try {
      changed = await documents.change(canvas, {
        revision: {
          op: call.op,
          by: call.by,
          ...(call.proposedBy === undefined ? {} : { proposedBy: call.proposedBy }),
          ...(call.request === undefined ? {} : { request: call.request }),
        },
        build: (document) => {
          signal.throwIfAborted();
          return build(document);
        },
        check: (change, live) => {
          checkExpect(call.expect, live);
          if (caller.kind === 'human') return;
          // Every refusal first: a proposal is only ever of what no rule refuses.
          let proposal: string | undefined;
          for (const rule of Object.values(rules)) {
            const outcome = rule(change, { caller, party });
            if (outcome && 'refuse' in outcome) throw new OpFailure('refused', outcome.refuse);
            proposal ??= outcome?.propose;
          }
          if (proposal === undefined) return;
          if (call.proposes !== true || propose === undefined) {
            throw new OpFailure(
              'refused',
              `${proposal}, and ${call.op} can’t come to them as a proposal: ask with canvas.delete or canvas.batch, which can.`,
            );
          }
          throw new Proposing(change, proposal);
        },
        committing: () => {
          call.noReturn();
        },
        ...(call.within === undefined ? {} : { within: call.within }),
      });
    } catch (error) {
      if (!(error instanceof Proposing) || propose === undefined) throw error;
      // Nothing of it applied: it waits for you.
      return { proposed: await propose(canvas, error.change, call) };
    }
    if (changed.committed === undefined) return { result: changed.result };
    committed?.(canvas, changed.committed.change);
    return { result: changed.result, rev: changed.committed.rev };
  };
}

/**
 * Throws a conflict if an entity `expect` names is at another revision in `live` (0: it isn't
 * there), saying what each such entity is now.
 */
function checkExpect(expect: Readonly<Record<string, number>> | undefined, live: LiveDocument) {
  const stale = Object.entries(expect ?? {}).filter(([key, rev]) => revOf(live, key) !== rev);
  if (stale.length === 0) return;
  const current: Record<string, Current> = {};
  for (const [key] of stale)
    current[key] = { rev: revOf(live, key), value: live.rows[key] ?? null };
  const [them, they] = stale.length === 1 ? ['it', 'it'] : ['them', 'they'];
  throw new OpFailure(
    'conflict',
    `${stale.map(([key, rev]) => `${key} is at revision ${String(revOf(live, key))}, not ${String(rev)}`).join('; ')}: ${they} changed since you read ${them}. Read ${them} again before you change ${them}.`,
    current,
  );
}

/** An entity's revision in `live`: 0 for one that isn't there. */
function revOf(live: LiveDocument, key: string): number {
  return live.rows[key] === undefined ? 0 : (live.revs.get(key) ?? 0);
}

/**
 * Why a token's new canvas holding `next` would be refused, as its commit over an empty document
 * would check it (its rows, R34's validation, every change rule): checked ahead where a proposal
 * would otherwise come first (canvas.create replacing a canvas only you may close), so that a
 * refusal wins over a proposal and Allow never applies what a rule refused. None if it would pass.
 */
export function refusalOf(
  next: CanvasDocument,
  call: { op: string; by: PartyId; caller: TokenCaller; party: Party },
  rules: Readonly<Partial<Record<Rule, ChangeRule>>>,
  context: { catalog: Catalog; defaultAdapter: AdapterId },
): string | undefined {
  const fault = rowsFault(next);
  if (fault !== undefined) return `That canvas can’t be kept: ${fault}.`;
  const empty: CanvasDocument = { id: next.id, arrange: false, nodes: [], links: [] };
  const before = { document: empty, rows: { [META]: { arrange: false } }, revs: new Map() };
  const change = changeSetOf(before, next, diffRows(before.rows, next, empty), call);
  const invalid = editFault(next, change.entities, context.catalog, context.defaultAdapter);
  if (invalid !== undefined) return invalid;
  for (const rule of Object.values(rules)) {
    const outcome = rule(change, { caller: call.caller, party: call.party });
    if (outcome && 'refuse' in outcome) return outcome.refuse;
  }
  return undefined;
}
