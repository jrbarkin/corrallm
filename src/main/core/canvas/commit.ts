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
import { fingerprint, heldFingerprint, safe } from '../workspaces/cleanup';
import type { CleanupDecision, Removal, TreeState } from '../workspaces/cleanup';
import { safeRemovals } from '../workspaces/planner';
import type { Removals } from '../workspaces/planner';

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
 *
 * Workspace-safety (B9a §7) is checked on every commit, yours too, after a token's rules: a change
 * leaving a worktree that holds work with no agent is yours to confirm (`workspaceSafety`), and its
 * plan's moves were checked before (the planner's preflight: no agent moved out of its tree).
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
  /** A proposal's original canvas: every entity the replay now changes must still match it. */
  unchanged?: Readonly<Record<string, number>>;
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
  /**
   * On Allow of a deletion's confirmation (B9a C7): what you chose of the trees it leaves with no
   * agent, bound to what each held when you were asked.
   */
  cleanup?: CleanupDecision;
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
  propose?: (
    canvas: CanvasId,
    change: ChangeSet,
    call: CommitCall,
    before: Readonly<Record<string, number>>,
    trees: readonly TreeState[],
  ) => Promise<NeedId>;
}

/**
 * Thrown in a change's check when it is yours to decide: it carries the change to propose, and what
 * the trees it leaves with no agent hold (B9a C7: what its confirmation asks of them).
 */
class Proposing extends Error {
  readonly change: ChangeSet;
  readonly before: Readonly<Record<string, number>>;
  readonly trees: readonly TreeState[];
  constructor(
    change: ChangeSet,
    why: string,
    before: Readonly<Record<string, number>>,
    trees: readonly TreeState[],
  ) {
    super(why);
    this.name = 'Proposing';
    this.change = change;
    this.before = before;
    this.trees = trees;
  }
}

/** Why a deletion leaving a tree with work in it waits for you, even yours (B9a C7). */
const CONFIRM =
  'Deleting the last agent of a worktree that holds work, or where one may still be writing, waits for the user to confirm what becomes of it';

export function committer({ documents, rules, committed, propose }: CommitterDeps): Committer {
  return async (canvas, build, call) => {
    const { caller, signal } = call;
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
        check: (change, live, losses) => {
          checkExpect(call.expect, live);
          const before = call.unchanged;
          if (before !== undefined) {
            checkExpect(
              Object.fromEntries([...change.entities.keys()].map((key) => [key, before[key] ?? 0])),
              live,
            );
          }
          const trees = losses?.trees ?? [];
          const revisions = () =>
            Object.fromEntries(Object.keys(live.rows).map((key) => [key, live.revs.get(key) ?? 0]));
          // A token's every rule first: a refusal wins, and a proposal is only ever of what no
          // rule refuses. You are checked by none of them.
          let proposal: string | undefined;
          if (caller.kind !== 'human') {
            for (const rule of Object.values(rules)) {
              const outcome = rule(change, { caller, party: call.party });
              if (outcome && 'refuse' in outcome) throw new OpFailure('refused', outcome.refuse);
              proposal ??= outcome?.propose;
            }
          }
          // Workspace-safety, whoever made the change (B9a §7, C7): what becomes of the trees it
          // leaves with no agent, yours to confirm where one holds work; removed with their last
          // agent where safe.
          const safety = workspaceSafety(trees, call.cleanup);
          proposal ??= safety.propose;
          if (proposal === undefined) return safety.removals;
          if (call.proposes !== true || propose === undefined) {
            throw new OpFailure(
              'refused',
              caller.kind === 'human'
                ? `${proposal}, and ${call.op} can’t ask: delete with canvas.delete or canvas.batch, which can.`
                : `${proposal}, and ${call.op} can’t come to them as a proposal: ask with canvas.delete or canvas.batch, which can.`,
            );
          }
          throw new Proposing(change, proposal, revisions(), trees);
        },
        committing: () => {
          call.noReturn();
        },
        ...(call.within === undefined ? {} : { within: call.within }),
      });
    } catch (error) {
      if (!(error instanceof Proposing) || propose === undefined) throw error;
      // Nothing of it applied: it waits for you.
      return { proposed: await propose(canvas, error.change, call, error.before, error.trees) };
    }
    if (changed.committed === undefined) return { result: changed.result };
    committed?.(canvas, changed.committed.change);
    return { result: changed.result, rev: changed.committed.rev };
  };
}

/**
 * The workspace-safety rule on a commit (RULES' `workspace-safety`, B9a §7), whoever made it: what
 * is decided of the trees it leaves with no agent. As you decided (`decision`, on a confirmation's
 * Allow, bound to what each held when you were asked: a conflict if any holds anything else now);
 * else those safe (clean, merged, no one writing there) removed, and, if any holds work or can't
 * be read, the change is yours to confirm (`propose`), yours too. Its other half, that no change
 * moves an agent out of the tree it works in, is the planner's (workspaces/planner.ts'
 * `unsafeStep`), on every commit's plan.
 */
export function workspaceSafety(
  trees: readonly TreeState[],
  decision: CleanupDecision | undefined,
): { removals: Removals; propose?: string } {
  const { removals, asks } = decided(trees, decision);
  return asks.length === 0 ? { removals } : { removals, propose: CONFIRM };
}

/**
 * What is decided of the trees a change leaves with no agent: as you decided (`decision`, bound to
 * what each held when you were asked: a conflict if any holds anything else now, or wasn't asked
 * of), else those safe removed and the others to ask about.
 */
function decided(
  trees: readonly TreeState[],
  decision: CleanupDecision | undefined,
): { removals: Removals; asks: readonly TreeState[] } {
  if (decision === undefined) {
    return {
      removals: safeRemovals({ retained: [], pending: [], removed: [], trees }),
      asks: trees.filter((tree) => !safe(tree)),
    };
  }
  for (const tree of trees) {
    if (decision.fingerprints[tree.workspace] !== fingerprint(tree)) {
      throw new OpFailure(
        'conflict',
        'A worktree it leaves with no agent changed since you were asked about it: decide again on what it holds now.',
      );
    }
  }
  if (decision.choice === 'keep') return { removals: new Map(), asks: [] };
  return {
    removals: new Map(
      trees.map((tree): [string, Removal] => [
        tree.workspace,
        { branch: true, force: true, approved: heldFingerprint(tree), tip: tree.tip },
      ]),
    ),
    asks: [],
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
