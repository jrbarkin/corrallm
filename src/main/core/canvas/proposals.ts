import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { NeedId } from '../../../shared/api/ids';
import { MAX_OPEN_PROPOSALS } from '../../../shared/api/limits';
import { PREPARED_SURFACE } from '../../../shared/api/prepared';
import { SURFACE } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasNode } from '../../../shared/model/canvas';
import { agentOf } from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';
import type { NeedsItem } from '../../../shared/model/needs';
import { andList } from '../../../shared/model/words';
import type { MessageStore, Staged } from '../delivery/messages';
import { OpFailure } from '../call';
import { nameOf, partyText } from '../parties';
import { RewindGuardSchema } from '../rewind-guard';
import type { RewindGuard } from '../rewind-guard';
import type { Database } from '../store/store';
import type { ChangeSet } from './change';
import { fingerprint, safe } from '../workspaces/cleanup';
import type { CleanupDecision, TreeState } from '../workspaces/cleanup';

/*
 * The proposals waiting for you (Core Server §6.9, B9 Design §5). A token's op whose change no rule
 * refuses but R4 reserves to you (it deletes an agent, alone or in a batch) applies nothing: the
 * core keeps it, in the profile's database (`proposal`), as a Needs item for you
 * (`proposal/<uuid>`), worded with what it would lose ("…asks to delete Reviewer: 3 queued tasks
 * and its conversation"), with the op, its arguments and the revisions of the canvas then. You
 * answer it with `reply` (ops/reply.ts): Allow runs the op again, as you, only if neither its
 * original touched entities nor anything the replay now changes has changed since, including
 * work added after the proposal (else it is settled stale, changing nothing); Refuse
 * settles it. Either way its proposer gets a record: a `settled` message from corrallm, written in
 * the same write as the settlement (and Allow's change), which its `wait` returns. Proposals
 * survive restarts; headless, they wait for the app, whose Needs you shows them.
 */

/** How a proposal was settled. */
export type Outcome = 'allowed' | 'refused' | 'stale';

/** The most agents a proposal's words name, then how many more there are. */
const NAMED = 5;

/** Why only you may choose either of a proposal's choices. */
const YOURS =
  'Deleting agents, or discarding their work, is the user’s to decide: no token’s say-so does it.';

/** A proposal waiting for you. */
export interface Proposal {
  /** Its Needs item's id: proposal/<uuid>. */
  id: NeedId;
  canvas: CanvasId;
  /** The op it would run, and its arguments as the op parsed them, but its request and expect. */
  op: string;
  args: Readonly<Record<string, unknown>>;
  /** The party that proposed it. */
  by: PartyId;
  /** Each entity its change touched, by key, with the revision it had then (0: none). */
  touched: Readonly<Record<string, number>>;
  /**
   * The canvas when proposed, for a change of a document's (always: Allow's replay may touch rows
   * the original build did not). None for a command, R4's argument half (a close, a replace, a
   * save), which no change of a document's carries: `touched` names its canvas's document and file,
   * whose fingerprints Allow checks instead.
   */
  before?: Readonly<Record<string, number>>;
  /** What it would do and lose, worded as it was raised. */
  lost: Lost;
  /**
   * For a code restore (R5): what it was of, files and all, as proposed (rewind-guard.ts), which
   * Allow reads again before it restores anything; any difference settles it stale.
   */
  guard?: RewindGuard;
  /**
   * For a deletion that leaves trees with no agent (B9a C7): what each held when proposed, which
   * its Allow (keep the work) or Discard is bound to: any difference settles it stale.
   */
  cleanup?: { trees: readonly TreeState[] };
  /** When it was raised, in epoch ms. */
  at: number;
}

/** What a proposal would do and lose, worded. */
export interface Lost {
  /** "delete Reviewer": what it would do, to finish "asks to …". */
  what: string;
  title: string;
  detail?: string;
  /** Every agent its words name as being deleted; all must be in a token reader's reach. */
  agents?: readonly string[];
  /** The first agent it would delete. */
  agent?: string;
}

/** What settles a proposal, prepared: written within a write, then told, or undone. */
export interface Settlement {
  /** Within a write: the proposal's outcome and its proposer's record. */
  within(): Staged;
  /** The record, once `within` staged it. */
  readonly record: Message | undefined;
}

export interface ProposalsDeps {
  /** The profile's database, which keeps them. */
  store: Database;
  /** A canvas's message store, where each proposer's record goes. */
  messages: (canvas: CanvasId) => Promise<MessageStore>;
  /** The agents of a canvas with a conversation kept for them, in any of their CLIs. */
  conversations: (canvas: CanvasId) => Promise<ReadonlySet<string>>;
  /** Hears what waits on a canvas change: a proposal raised or settled, and by whom. */
  changed?: (canvas: CanvasId, by: PartyId) => void;
  now?: () => number;
  /** The id each proposal raised takes: a random UUID but in tests. */
  newId?: () => string;
}

export class Proposals {
  readonly #deps: ProposalsDeps;
  readonly #now: () => number;
  readonly #newId: () => string;
  /** Each canvas's proposals waiting, once read, by id, oldest first. */
  readonly #open = new Map<CanvasId, Map<NeedId, Proposal>>();

  constructor(deps: ProposalsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#newId = deps.newId ?? randomUUID;
  }

  /** The proposals waiting on a canvas, oldest first: none if they can't be read. */
  open(canvas: CanvasId): Proposal[] {
    return [...(this.#read(canvas)?.values() ?? [])];
  }

  /** A proposal waiting on a canvas, by its id. */
  get(canvas: CanvasId, id: string): Proposal | undefined {
    return this.#read(canvas)?.get(id as NeedId);
  }

  /** How a proposal no longer waiting was settled, and by whom, if it was raised at all. */
  settled(canvas: CanvasId, id: string): { outcome: Outcome; by: PartyId } | undefined {
    if (!id.startsWith('proposal/')) return undefined;
    try {
      const row = this.#deps.store
        .prepare(
          `SELECT outcome, settled_by FROM proposal
           WHERE id = ? AND canvas_id = ? AND outcome IS NOT NULL`,
        )
        .get(id.slice('proposal/'.length), canvas);
      return row === undefined
        ? undefined
        : { outcome: row.outcome as Outcome, by: row.settled_by as PartyId };
    } catch {
      return undefined;
    }
  }

  /**
   * The waiting proposals, oldest first. A token's reach must cover every agent their words name,
   * never only the first removed agent; command proposals (on no agent) stay yours alone.
   */
  items(canvas: CanvasId, reach?: readonly string[]): NeedsItem[] {
    return this.open(canvas)
      .filter((proposal) => {
        if (reach === undefined) return true;
        const author = agentOf(proposal.by);
        return (
          proposal.lost.agents !== undefined &&
          proposal.lost.agents.every((agent) => reach.includes(agent)) &&
          (author === undefined || reach.includes(author))
        );
      })
      .map(itemOf);
  }

  /**
   * Raises a proposal for you of `op` with `args`, proposed by `by`, whose change is `change`: kept
   * on disk before it resolves with its id; rejects, keeping nothing, if it couldn't be. A change
   * of a document's carries the canvas's revisions as it was proposed (`before`), which Allow's
   * replay checks. One that is no change of a document's (R4's argument half: a close, a replace,
   * a save) has none: it says what it touches, its canvas's document and file, and what it would
   * do and lose itself (`touched`, `lost`).
   */
  async raise(
    canvas: CanvasId,
    raised: {
      op: string;
      args: Readonly<Record<string, unknown>>;
      by: PartyId;
    } & (
      | {
          change: ChangeSet;
          before: Readonly<Record<string, number>>;
          /** What the trees it leaves with no agent hold now (B9a C7). */
          trees?: readonly TreeState[];
        }
      | { touched: Readonly<Record<string, number>>; lost: Lost; guard?: RewindGuard }
    ),
  ): Promise<NeedId> {
    const { op, args, by } = raised;
    const open = this.#read(canvas);
    if (open === undefined) throw new Error('The canvas’s proposals can’t be read.');
    let touched: Readonly<Record<string, number>>;
    let lost: Lost;
    let before: Readonly<Record<string, number>> | undefined;
    let guard: RewindGuard | undefined;
    let cleanup: { trees: readonly TreeState[] } | undefined;
    if ('change' in raised) {
      const { change } = raised;
      touched = Object.fromEntries([...change.entities].map(([key, { rev }]) => [key, rev ?? 0]));
      const inner = Array.isArray(args.ops) ? args.ops.length : undefined;
      const trees = raised.trees ?? [];
      lost = wordsOf(change, await this.#deps.conversations(canvas), inner, trees);
      before = raised.before;
      cleanup = trees.length === 0 ? undefined : { trees };
    } else {
      ({ touched, lost, guard } = raised);
    }
    // Check inside the write lane too: two raises may have awaited conversations together.
    const { proposal, made } = await this.#deps.store.write(() => {
      const rows = this.#deps.store
        .prepare(
          `SELECT id, op, args, by_party, touched, lost, raised_at FROM proposal
         WHERE canvas_id = ? AND by_party = ? AND outcome IS NULL`,
        )
        .all(canvas, by);
      for (const row of rows) {
        const pending = proposalOf(row, canvas);
        if (
          pending?.op === op &&
          isDeepStrictEqual(pending.args, args) &&
          isDeepStrictEqual(pending.touched, touched) &&
          isDeepStrictEqual(pending.before, before) &&
          isDeepStrictEqual(pending.guard, guard) &&
          isDeepStrictEqual(pending.cleanup, cleanup)
        ) {
          return { proposal: pending, made: false };
        }
      }
      if (rows.length >= MAX_OPEN_PROPOSALS) {
        throw new OpFailure(
          'refused',
          `A party may have at most ${String(MAX_OPEN_PROPOSALS)} open proposals on a canvas: settle one before proposing another.`,
        );
      }
      const uuid = this.#newId();
      const proposal: Proposal = {
        id: `proposal/${uuid}` as NeedId,
        canvas,
        op,
        args,
        by,
        touched,
        ...(before === undefined ? {} : { before }),
        lost,
        ...(guard === undefined ? {} : { guard }),
        ...(cleanup === undefined ? {} : { cleanup }),
        at: this.#now(),
      };
      this.#deps.store
        .prepare(
          `INSERT INTO proposal (id, canvas_id, op, args, by_party, touched, lost, raised_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uuid,
          canvas,
          op,
          JSON.stringify(args),
          by,
          // What guards it is kept with what it touched: the guard of a code restore too, and
          // what the trees a deletion leaves held.
          JSON.stringify({ touched, before, guard, cleanup }),
          JSON.stringify(lost),
          proposal.at,
        );
      return { proposal, made: true };
    });
    open.set(proposal.id, proposal);
    if (made) this.#deps.changed?.(canvas, by);
    return proposal.id;
  }

  /**
   * What settles `proposal` as `outcome`, by `by` (and why, for a stale one): prepared, so that a
   * write (Allow's change's, or its own: `settle`) holds it, with the record its proposer gets.
   */
  async settlement(
    proposal: Proposal,
    outcome: Outcome,
    by: PartyId,
    why?: string,
  ): Promise<Settlement> {
    const messages = await this.#deps.messages(proposal.canvas);
    let record: Message | undefined;
    return {
      get record() {
        return record;
      },
      within: () => {
        const at = this.#now();
        const { changes } = this.#deps.store
          .prepare(
            `UPDATE proposal SET outcome = ?, settled_by = ?, settled_at = ?
             WHERE id = ? AND outcome IS NULL`,
          )
          .run(outcome, by, at, proposal.id.slice('proposal/'.length));
        if (Number(changes) !== 1) throw new Error(`${proposal.id} was settled already.`);
        const staged = messages.stageWithin({
          from: 'corrallm',
          to: proposal.by,
          kind: 'settled',
          origin: 'party',
          body: recordOf(proposal, outcome, by, why),
          state: 'delivered',
        });
        record = staged.message;
        return {
          reveal: () => {
            this.#read(proposal.canvas)?.delete(proposal.id);
            staged.reveal();
            this.#deps.changed?.(proposal.canvas, by);
          },
          undo: () => {
            record = undefined;
            staged.undo();
          },
        };
      },
    };
  }

  /**
   * Settles `proposal` as `outcome`, by `by` (and why, for a stale one), in a write of its own: its
   * proposer's record, once it is on disk; rejects, settling nothing, if it couldn't be.
   */
  async settle(proposal: Proposal, outcome: Outcome, by: PartyId, why?: string): Promise<Message> {
    const settlement = await this.settlement(proposal, outcome, by, why);
    let staged: Staged | undefined;
    try {
      await this.#deps.store.write(() => {
        staged = settlement.within();
      });
    } catch (error) {
      staged?.undo();
      throw error;
    }
    staged?.reveal();
    const { record } = settlement;
    if (record === undefined) throw new Error(`${proposal.id} wasn’t settled.`);
    return record;
  }

  /** A canvas's proposals waiting, read from the database once: none if they can't be read. */
  #read(canvas: CanvasId): Map<NeedId, Proposal> | undefined {
    let open = this.#open.get(canvas);
    if (open !== undefined) return open;
    let rows: Record<string, unknown>[];
    try {
      rows = this.#deps.store
        .prepare(
          `SELECT id, op, args, by_party, touched, lost, raised_at FROM proposal
           WHERE canvas_id = ? AND outcome IS NULL ORDER BY raised_at, rowid`,
        )
        .all(canvas);
    } catch (error) {
      console.error('Could not read the canvas’s proposals:', error);
      return undefined;
    }
    open = new Map();
    for (const row of rows) {
      const proposal = proposalOf(row, canvas);
      if (proposal !== undefined) open.set(proposal.id, proposal);
    }
    this.#open.set(canvas, open);
    return open;
  }
}

/**
 * Whether `op` is a change of a canvas's document (a `doc` op's, or a test registry's op), which
 * carries the canvas as it was proposed and, on Allow, its settlement; else it is a command (R4's
 * argument half: canvas.close, canvas.create, canvas.save).
 */
export function isDocOp(op: string): boolean {
  // A prepared op (B11 C6's, until X9 registers it) is a command: a code restore's.
  if (Object.hasOwn(PREPARED_SURFACE, op)) return false;
  return !Object.hasOwn(SURFACE, op) || SURFACE[op as keyof typeof SURFACE].kind === 'doc';
}

/**
 * A proposal's Needs item, for you: Allow and Refuse, both yours alone. A deletion that leaves a
 * tree holding work (B9a C7) offers what becomes of it instead: delete, keeping its work (Allow),
 * delete and discard it, or cancel (Refuse).
 */
export function itemOf(proposal: Proposal): NeedsItem {
  const { lost } = proposal;
  const asks = proposal.cleanup?.trees.some((tree) => !safe(tree)) === true;
  return {
    id: proposal.id,
    canvas: proposal.canvas,
    ...(lost.agent === undefined ? {} : { agent: lost.agent }),
    kind: 'proposal',
    for: 'you',
    by: ['you'],
    title: lost.title,
    ...(lost.detail === undefined ? {} : { detail: lost.detail }),
    choices: asks
      ? [
          {
            value: 'allow',
            label: 'Delete, keep its work',
            description:
              'Delete it; its worktree and branch are kept, in Kept worktrees, unless they changed since.',
            humanOnly: YOURS,
          },
          {
            value: 'discard',
            label: 'Delete, and discard its worktree and branch',
            description: 'Delete it and remove its worktree and branch, with the work in them.',
            humanOnly: YOURS,
          },
          { value: 'refuse', label: 'Cancel', humanOnly: YOURS },
        ]
      : [
          {
            value: 'allow',
            label: 'Allow',
            description: 'Apply it as yours, unless what it changes has changed since.',
            humanOnly: YOURS,
          },
          { value: 'refuse', label: 'Refuse', humanOnly: YOURS },
        ],
    answerIn: 'api',
  };
}

/** Your decision on a deletion's proposal, of the trees it leaves (none: it asked nothing of them). */
export function cleanupOf(proposal: Proposal, choice: string): CleanupDecision | undefined {
  const trees = proposal.cleanup?.trees ?? [];
  if (!trees.some((tree) => !safe(tree))) return undefined;
  return {
    choice: choice === 'discard' ? 'discard' : 'keep',
    fingerprints: Object.fromEntries(trees.map((tree) => [tree.workspace, fingerprint(tree)])),
  };
}

/**
 * What a change would do and lose, worded: the agents it would delete, each with its queued tasks
 * and whether a conversation of its is kept (`conversations`), and, for a batch of `inner` ops, the
 * rest of it.
 */
function wordsOf(
  change: ChangeSet,
  conversations: ReadonlySet<string>,
  inner: number | undefined,
  trees: readonly TreeState[] = [],
): Lost {
  const { nodes } = change.before;
  const removed = nodes.filter((node) => change.removed.has(node.id));
  const loses = (node: CanvasNode) => {
    const tasks = node.type === 'agent' ? (node.data.queue?.length ?? 0) : 0;
    const parts = [
      ...(tasks === 0 ? [] : [`${String(tasks)} queued task${tasks === 1 ? '' : 's'}`]),
      ...(conversations.has(node.id) ? ['its conversation'] : []),
    ];
    return parts.length === 0 ? 'nothing queued' : andList(parts);
  };
  const named = removed.slice(0, NAMED);
  const more = removed.length - named.length;
  const names = andList([
    ...named.map((node) => nameOf(nodes, node.id)),
    ...(more > 0 ? [`${String(more)} more`] : []),
  ]);
  const what = `delete ${names}`;
  const [only] = removed;
  const who = partyText(nodes, change.by);
  const title =
    removed.length === 1 && only !== undefined
      ? `${who} asks to ${what}: ${loses(only)}`
      : `${who} asks to ${what}: ${andList(named.map((node) => `${nameOf(nodes, node.id)} (${loses(node)})`))}`;
  const others = inner === undefined ? 0 : inner - 1;
  const work = treeWords(nodes, trees);
  const details = [
    ...(work === undefined ? [] : [work]),
    ...(inner === undefined
      ? []
      : [
          `It comes in a batch with ${String(others)} other change${others === 1 ? '' : 's'}: Allow applies all of it, as one change, and Refuse none.`,
        ]),
  ];
  return {
    what,
    // Yours (a deletion of yours waiting for you to confirm it), it is a question to you.
    title: change.by === 'you' ? `Delete ${names}? Its worktree holds work.` : title,
    agents: removed.map((node) => node.id),
    ...(details.length === 0 ? {} : { detail: details.join(' ') }),
    ...(only === undefined ? {} : { agent: only.id }),
  };
}

/**
 * What the trees a deletion leaves with no agent hold, in words, of those that aren't safe to
 * remove (none if all are): "Its worktree has 2 changed files and commits not in the project’s
 * checkout (README.md and notes.md); Builder may still be writing there."
 */
function treeWords(nodes: readonly CanvasNode[], trees: readonly TreeState[]): string | undefined {
  const unsafe = trees.filter((tree) => !safe(tree));
  if (unsafe.length === 0) return undefined;
  const files = (count: number, kind: string) =>
    `${String(count)} ${kind} file${count === 1 ? '' : 's'}`;
  return unsafe
    .map((tree) => {
      if (tree.unknown !== undefined) {
        return `corrallm can’t tell what its worktree holds (${tree.unknown}): it is kept unless you discard it.`;
      }
      const parts = [
        ...(tree.changed > 0 ? [files(tree.changed, 'changed')] : []),
        ...(tree.untracked > 0 ? [files(tree.untracked, 'untracked')] : []),
        ...(tree.merged ? [] : ['commits not in the project’s checkout']),
      ];
      const named = tree.paths.slice(0, NAMED);
      const more = tree.changed + tree.untracked - named.length;
      const paths =
        named.length === 0
          ? ''
          : ` (${andList([...named, ...(more > 0 ? [`${String(more)} more`] : [])])})`;
      const holds = parts.length === 0 ? '' : `Its worktree has ${andList(parts)}${paths}.`;
      const writers = [
        ...tree.writers.map((agent) => nameOf(nodes, agent)),
        ...(tree.setup ? ['its setup command'] : []),
      ];
      const writing = writers.length === 0 ? '' : `${andList(writers)} may still be writing there.`;
      return [holds, writing].filter((one) => one !== '').join(' ');
    })
    .join(' ');
}

/** The record a proposer gets of how its proposal was settled. */
function recordOf(proposal: Proposal, outcome: Outcome, by: PartyId, why?: string): string {
  const { id, lost } = proposal;
  // Your own deletion's confirmation (B9a C7): told to you as yours.
  if (proposal.by === 'you') {
    switch (outcome) {
      case 'allowed':
        return `You confirmed: ${lost.what}. It is done.`;
      case 'refused':
        return `You cancelled: ${lost.what}. Nothing changed.`;
      case 'stale':
        return `Your confirmation to ${lost.what} went stale: ${why ?? 'what it would change has changed since'}, so nothing changed.`;
    }
  }
  const who = by === 'you' ? 'The user' : partyText([], by);
  switch (outcome) {
    case 'allowed':
      return `${who} allowed your proposal ${id} to ${lost.what}: it is done, as their change.`;
    case 'refused':
      return `${who} refused your proposal ${id} to ${lost.what}: nothing changed.`;
    case 'stale':
      return `Your proposal ${id} to ${lost.what} went stale: ${who === 'The user' ? 'the user' : who} allowed it, but ${why ?? 'what it would change has changed since you proposed it'}, so nothing changed. Read the canvas again, and propose it anew if it still holds.`;
  }
}

/** A row of `proposal`, waiting: undefined if it isn't one this code reads. */
function proposalOf(row: Record<string, unknown>, canvas: CanvasId): Proposal | undefined {
  try {
    const { id, op, by_party: by, raised_at: at } = row;
    const args: unknown = JSON.parse(String(row.args));
    const clock: unknown = JSON.parse(String(row.touched));
    if (!isRecord(clock)) return undefined;
    const { touched, before } = clock;
    // A guard that doesn't read back as one is no proposal: it is never applied unguarded.
    const guard = clock.guard === undefined ? undefined : RewindGuardSchema.safeParse(clock.guard);
    if (guard?.success === false) return undefined;
    // Nor is what the trees of a deletion held: its Allow is bound to it.
    const cleanup = clock.cleanup === undefined ? undefined : cleanupRead(clock.cleanup);
    if (cleanup === null) return undefined;
    const lost: unknown = JSON.parse(String(row.lost));
    if (
      typeof id !== 'string' ||
      typeof op !== 'string' ||
      typeof by !== 'string' ||
      typeof at !== 'number' ||
      !isRecord(args) ||
      !revisions(touched) ||
      // A change of a document's is read only with the canvas as it was proposed; a command has none.
      (isDocOp(op) ? !revisions(before) : before !== undefined) ||
      !isRecord(lost) ||
      typeof lost.what !== 'string' ||
      typeof lost.title !== 'string' ||
      (lost.agents !== undefined &&
        (!Array.isArray(lost.agents) || !lost.agents.every((agent) => typeof agent === 'string')))
    ) {
      return undefined;
    }
    return {
      id: `proposal/${id}` as NeedId,
      canvas,
      op,
      args,
      by: by as PartyId,
      touched,
      ...(revisions(before) ? { before } : {}),
      lost: lost as unknown as Lost,
      ...(guard === undefined ? {} : { guard: guard.data }),
      ...(cleanup === undefined ? {} : { cleanup }),
      at,
    };
  } catch {
    return undefined;
  }
}

/** What the trees of a deletion held, as kept with its proposal: null if it doesn't read as that. */
function cleanupRead(value: unknown): { trees: TreeState[] } | null {
  if (!isRecord(value) || !Array.isArray(value.trees)) return null;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((one) => typeof one === 'string');
  const oid = (one: unknown) => one === null || typeof one === 'string';
  const read = value.trees.every(
    (tree: unknown) =>
      isRecord(tree) &&
      typeof tree.workspace === 'string' &&
      oid(tree.head) &&
      oid(tree.tip) &&
      Number.isSafeInteger(tree.changed) &&
      Number.isSafeInteger(tree.untracked) &&
      strings(tree.paths) &&
      typeof tree.merged === 'boolean' &&
      strings(tree.writers) &&
      typeof tree.setup === 'boolean' &&
      (tree.unknown === undefined || typeof tree.unknown === 'string') &&
      typeof tree.status === 'string',
  );
  return read ? { trees: value.trees as TreeState[] } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revisions(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (at) => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0,
    )
  );
}
