import type { CanvasId } from '../../../shared/canvas';
import type { PartyId } from '../../../shared/model/messages';
import type { NeedsItem } from '../../../shared/model/needs';
import { andList } from '../../../shared/model/words';
import { OpFailure } from '../call';
import { decided, decidedOf } from '../decisions';
import type { MessageStore } from '../delivery/messages';
import { partyText } from '../parties';
import type { ReplyHandler } from '../replies';
import type { WorkspaceGate } from './gate';
import { ownerNode } from './planner';
import { ProvisionError } from './provision';
import type { Base, Provisioner } from './provision';
import { ACTIVE_STATES } from './store';
import type { WorkspaceStore, WorktreeRecord } from './store';

/*
 * A workspace's change, waiting for you (B9a Design §3, "Grouping, ungrouping and project changes";
 * the Switch the planner leaves to the reply router, C7): a materialized agent moved into another
 * group (or out of one) keeps working in its old tree, its new starts and sends held, until you
 * switch it. One card per destination, not per member, naming no agent (so no token's view of
 * Needs holds it, nor can a token name it: reach), yours alone, at the generation of the plan it
 * shows (`rebind/<owner>/<generation>`: planned again, it is another card).
 *
 * Switch, once you chose it, is checked again against the plan as it is now; its destination is
 * made if it isn't yet (provisioning: Git, never waiting for a person); then, under the workspace
 * mutation gate (refused while any agent of the old or new tree may be writing, new work for all
 * of them held meanwhile), each member's session is ended (its next turn starts where it works
 * then), its binding to the destination installed at the generation you saw, and each old tree no
 * agent works in any more retained, its work and branch kept: never merged, copied or removed. Who
 * decided is recorded (decisions.ts). Not now is to leave it: moving the agents back drops it.
 */

const YOURS = 'Only you decide where an agent’s work goes.';

export interface WorkspaceChangesDeps {
  workspaces: WorkspaceStore;
  /** Read old committed tips through the C runner, and publish a lost checkout's state. */
  provisioner?: Pick<Provisioner, 'base' | 'checkout'>;
  gate: Pick<WorkspaceGate, 'drain'>;
  /** Ends an agent's session without starting another (its next turn starts one where it works). */
  close: (canvas: CanvasId, agent: string) => Promise<void>;
  /** A destination made for an owner that has none yet (provisioning): none, it can't be made. */
  provision?: (canvas: CanvasId, owner: string) => Promise<WorktreeRecord>;
  /** An agent's, or an owner's, name on its canvas. */
  nameOf: (canvas: CanvasId, id: string) => string;
  /** The canvas's messages, where who decided is recorded. */
  messages: (canvas: CanvasId) => Promise<MessageStore>;
  /** The canvas's messages, if they are read already (a canvas the core runs). */
  messagesNow?: (canvas: CanvasId) => MessageStore | undefined;
  /** Hears that a canvas's workspaces (and Needs) changed. */
  changed?: (canvas: CanvasId) => void;
}

/** A change waiting: its destination owner, its members, and the latest generation planned. */
interface Waiting {
  owner: string;
  agents: string[];
  generation: number;
}

export class WorkspaceChanges {
  readonly #deps: WorkspaceChangesDeps;

  constructor(deps: WorkspaceChangesDeps) {
    this.#deps = deps;
  }

  /** The canvas's workspace changes waiting for you: one card per destination. */
  items(canvas: CanvasId): NeedsItem[] {
    return this.#waiting(canvas).map((waiting) => this.#item(canvas, waiting));
  }

  /** The reply router's handler of these cards: Switch, yours alone. */
  handler(): ReplyHandler {
    return {
      prefixes: ['rebind'],
      current: (canvas, to) => this.items(canvas).find((item) => item.id === to),
      gone: (canvas, to) => this.#gone(canvas, to),
      act: async (canvas, item, answer, ctx) => {
        if ('choice' in answer && answer.choice === 'not-now') return { outcome: 'kept' };
        const id = idOf(item.id);
        if (id === undefined) throw notFound(item.id);
        return this.#switch(canvas, id, ctx.by, () => {
          ctx.noReturn();
        });
      },
    };
  }

  /** Each destination's change waiting on the canvas, in the order its members are. */
  #waiting(canvas: CanvasId): Waiting[] {
    const byOwner = new Map<string, Waiting>();
    for (const binding of this.#deps.workspaces.bindingsOf(canvas)) {
      if (binding.desired === null) continue;
      const { owner, generation } = binding.desired;
      const waiting = byOwner.get(owner) ?? { owner, agents: [], generation: 0 };
      waiting.agents.push(binding.agent);
      waiting.generation = Math.max(waiting.generation, generation);
      byOwner.set(owner, waiting);
    }
    return [...byOwner.values()];
  }

  #item(canvas: CanvasId, { owner, agents, generation }: Waiting): NeedsItem {
    const names = andList(agents.map((agent) => this.#deps.nameOf(canvas, agent)));
    const where = this.#where(canvas, owner, agents);
    const they = agents.length === 1 ? 'Its session keeps' : 'Their sessions keep';
    const missing = agents.some((agent) => {
      const binding = this.#deps.workspaces.binding(canvas, agent);
      return (
        binding !== undefined &&
        this.#deps.workspaces.worktree(binding.workspace)?.state === 'missing'
      );
    });
    return {
      id: `rebind/${encodeURIComponent(owner)}/${String(generation)}`,
      canvas,
      kind: 'worktree',
      for: 'you',
      by: ['you'],
      title: `Move ${names} to ${where}?`,
      detail: `${missing ? 'Its previous worktree is missing. Restore it before switching; Not now leaves new work held. ' : ''}${they} working where ${agents.length === 1 ? 'it is' : 'they are'} until you switch. Switching ends ${agents.length === 1 ? 'it' : 'them'} and starts ${agents.length === 1 ? 'it' : 'them'} again there; the worktrees they leave are kept, with their work and branches, never merged or removed. To leave them where they are, move them back.`,
      choices: [
        { value: 'switch', label: 'Switch, keeping the previous worktrees', humanOnly: YOURS },
        ...(missing ? [{ value: 'not-now', label: 'Not now', humanOnly: YOURS }] : []),
      ],
      answerIn: 'api',
    };
  }

  /** Where a destination owner's agents work, as a card says it. */
  #where(canvas: CanvasId, owner: string, agents: readonly string[]): string {
    const root = ownerNode(owner);
    if (owner.startsWith('agent/') && agents.length === 1 && agents[0] === root) {
      return 'a worktree of its own';
    }
    return `${this.#deps.nameOf(canvas, root)}’s worktree`;
  }

  #gone(canvas: CanvasId, to: string): OpFailure | undefined {
    const id = idOf(to);
    if (id === undefined) return undefined;
    const now = this.#waiting(canvas).find(({ owner }) => owner === id.owner);
    if (now !== undefined) {
      return new OpFailure(
        'conflict',
        `${to} was planned again since: answer the change waiting now (rebind/${encodeURIComponent(now.owner)}/${String(now.generation)}).`,
      );
    }
    const messages = this.#deps.messagesNow?.(canvas);
    const record = messages === undefined ? undefined : decidedOf(messages, to);
    return record === undefined
      ? undefined
      : new OpFailure('conflict', `${to} is settled already: ${record.body}`);
  }

  #bindings(canvas: CanvasId, agents: readonly string[]): string {
    return JSON.stringify(
      agents.map((agent) => {
        const binding = this.#deps.workspaces.binding(canvas, agent);
        return [agent, binding?.workspace, binding?.generation, binding?.desired];
      }),
    );
  }

  async #source(
    canvas: CanvasId,
    repositoryId: string,
    workspace: string,
  ): Promise<Base | undefined> {
    const { provisioner, workspaces } = this.#deps;
    if (provisioner === undefined) return undefined; // Isolated service tests can omit Git.
    const repository = workspaces.repository(repositoryId);
    const tree = workspaces.worktree(workspace);
    if (repository === undefined || tree === undefined)
      throw new OpFailure(
        'unavailable',
        'Its previous worktree can’t be read now: restore it before switching.',
      );
    try {
      return await provisioner.base(repository, tree);
    } catch (error) {
      if (!(error instanceof ProvisionError)) throw error;
      // base refuses unknown HEADs; checkout records missing/error for the card and resolver.
      await provisioner.checkout(workspace);
      this.#deps.changed?.(canvas);
      throw new OpFailure('unavailable', error.message);
    }
  }

  async #switch(
    canvas: CanvasId,
    { owner, generation }: { owner: string; generation: number },
    by: PartyId,
    noReturn: () => void,
  ) {
    const { workspaces } = this.#deps;
    const current = () => {
      const waiting = this.#waiting(canvas).find((one) => one.owner === owner);
      if (waiting?.generation !== generation) {
        throw new OpFailure(
          'conflict',
          'That change was planned again, or dropped, since you were asked: answer what waits now.',
        );
      }
      return waiting;
    };
    const waiting = current();
    const link = workspaces.canvasRepository(canvas);
    const repository = link?.repository ?? null;
    if (repository === null) {
      throw new OpFailure('unavailable', 'The canvas’s project folder isn’t a repository now.');
    }
    const expected = this.#bindings(canvas, waiting.agents);
    const sources = [
      ...new Set(
        waiting.agents.flatMap((agent) => {
          const binding = workspaces.binding(canvas, agent);
          return binding === undefined ? [] : [binding.workspace];
        }),
      ),
    ];
    // Detect a lost source before allocation too: no fallback to the project's HEAD.
    for (const source of sources) await this.#source(canvas, repository, source);
    // Its destination, made first if it is new (provisioning waits for no one).
    let destination = workspaces.activeWorktree(canvas, repository, owner as never);
    if (destination === undefined) {
      if (this.#deps.provision === undefined) {
        throw new OpFailure('unavailable', 'Its new worktree can’t be made yet.');
      }
      destination = await this.#deps.provision(canvas, owner);
    }
    const target = destination;
    const from = [
      ...new Set(
        waiting.agents.flatMap((agent) => {
          const binding = workspaces.binding(canvas, agent);
          return binding === undefined ? [] : [binding.workspace];
        }),
      ),
    ];
    const switched = await this.#deps.gate.drain(
      canvas,
      [...from, target.id].map((workspace) => `workspace:${workspace}` as const),
      async () => {
        // Still the plan you saw, now that nothing else changes there.
        const members = current().agents;
        const bases = new Map<string, Base>();
        for (const source of from) {
          const base = await this.#source(canvas, repository, source);
          if (base !== undefined) bases.set(source, base);
        }
        const active = workspaces.activeWorktree(canvas, repository, owner as never);
        const source = target.forkedFrom === null ? undefined : bases.get(target.forkedFrom);
        const staleFork =
          workspaces.bindingsTo(canvas, target.id).length === 0 &&
          target.forkedFrom !== null &&
          (!from.includes(target.forkedFrom) ||
            (source !== undefined &&
              (source.oid !== target.baseOid ||
                source.ref !== target.baseRef ||
                source.checkout !== target.baseCheckout)));
        // No desired-plan bump alone closes a session; superseding only makes a new card.
        if (
          workspaces.canvasRepository(canvas)?.generation !== link?.generation ||
          this.#bindings(canvas, members) !== expected ||
          active?.id !== target.id ||
          active.generation !== target.generation ||
          staleFork
        ) {
          await workspaces.write((w) => {
            current();
            noReturn();
            const tree = w.worktree(target.id);
            if (
              tree !== undefined &&
              ACTIVE_STATES.includes(tree.state) &&
              w.bindingsTo(canvas, tree.id).length === 0
            )
              w.retain(tree.id);
            for (const agent of current().agents) w.plan(canvas, agent, owner as never);
          });
          return false;
        }
        // The source reads may have yielded to another commit: recheck before closing anything.
        current();
        noReturn();
        for (const agent of members) await this.#deps.close(canvas, agent);
        await workspaces.write((w) => {
          for (const agent of members) w.bind(canvas, agent, target.id);
          for (const workspace of from) {
            const tree = w.worktree(workspace);
            if (
              tree !== undefined &&
              ACTIVE_STATES.includes(tree.state) &&
              w.bindingsTo(canvas, workspace).length === 0
            ) {
              w.retain(workspace);
            }
          }
        });
        return true;
      },
    );
    this.#deps.changed?.(canvas);
    if (!switched) {
      const raised = this.items(canvas).find((item) => idOf(item.id)?.owner === owner)?.id;
      return { outcome: 'superseded' as const, ...(raised === undefined ? {} : { raised }) };
    }
    const messages = await this.#deps.messages(canvas);
    const names = andList(waiting.agents.map((agent) => this.#deps.nameOf(canvas, agent)));
    const record = decided(messages, {
      need: `rebind/${encodeURIComponent(owner)}/${String(generation)}`,
      by,
      words: `${by === 'you' ? 'You' : partyText([], by)} switched ${names} to ${this.#where(canvas, owner, waiting.agents)}: the worktrees they left are kept.`,
    });
    await messages.durable().catch(() => undefined);
    return { id: record.id, outcome: 'completed' as const };
  }
}

/** A card's id, read back: its destination owner and generation. */
function idOf(id: string): { owner: string; generation: number } | undefined {
  const match = /^rebind\/([^/]+)\/(\d{1,16})$/.exec(id);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  try {
    return { owner: decodeURIComponent(match[1]), generation: Number(match[2]) };
  } catch {
    return undefined;
  }
}

function notFound(to: string): OpFailure {
  return new OpFailure('not-found', `There is no Needs item ${to} on this canvas.`);
}
