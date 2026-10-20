import type { Current } from '../../../shared/api/errors';
import type { Party, Rule } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { OpFailure } from '../call';
import type { Caller, TokenCaller } from '../caller';
import type { ChangeSet } from './change';
import { CommitFailed } from './documents';
import type { Built, Documents, LiveDocument } from './documents';

/*
 * An op's commit to a canvas's document (B9 Design §3), what ctx.commit does: in the canvas's turn,
 * what the op builds over the live document, unless its call was superseded meanwhile, is checked
 * against the revisions its caller expects of entities (a conflict, saying what each is now, if
 * any has another), and, for a token, against every change rule (Core Server §3.6: whatever op made
 * the change, refused if any rule says so); then, past its point of no return, written
 * write-through (canvas/documents.ts). An op that changes nothing is checked against nothing. What
 * follows a commit (`committed`: the canvas's engine following its document) runs once it is on
 * disk, or once a commit whose flush failed is in the document all the same.
 */

/** Checks a change rule on a token's change: refuses it, saying why, or lets it be. */
export type ChangeRule = (
  change: ChangeSet,
  call: { caller: TokenCaller; party: Party },
) => { refuse: string } | undefined;

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
}

/** Commits what `build` makes of canvas `canvas`'s document in `call`: the result, and its revision. */
export type Committer = <R>(
  canvas: CanvasId,
  build: (document: CanvasDocument) => Built<R>,
  call: CommitCall,
) => Promise<{ result: R; rev?: number }>;

export interface CommitterDeps {
  documents: Pick<Documents, 'change'>;
  /** The change rules a token's commit is checked against, by rule. */
  rules: Readonly<Partial<Record<Rule, ChangeRule>>>;
  /** What follows a commit, once it is on disk. */
  committed?: (canvas: CanvasId, change: ChangeSet) => void;
}

export function committer({ documents, rules, committed }: CommitterDeps): Committer {
  return async (canvas, build, call) => {
    const { caller, party, signal } = call;
    /** What it changes, once checked. */
    let checked: ChangeSet | undefined;
    const changed = await documents
      .change(canvas, {
        revision: {
          op: call.op,
          by: call.by,
          ...(call.request === undefined ? {} : { request: call.request }),
        },
        build: (document) => {
          signal.throwIfAborted();
          return build(document);
        },
        check: (change, live) => {
          checked = change;
          checkExpect(call.expect, live);
          if (caller.kind === 'human') return;
          for (const rule of Object.values(rules)) {
            const outcome = rule(change, { caller, party });
            if (outcome) throw new OpFailure('refused', outcome.refuse);
          }
        },
        committing: () => {
          call.noReturn();
        },
      })
      .catch((error: unknown) => {
        // Made, though it may not be on disk: the document is the changed one, so it is followed.
        if (error instanceof CommitFailed && error.made === true && checked !== undefined) {
          committed?.(canvas, checked);
        }
        throw error;
      });
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
