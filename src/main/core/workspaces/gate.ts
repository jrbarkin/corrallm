import type { CanvasId } from '../../../shared/canvas';
import { andList } from '../../../shared/model/words';
import { OpFailure } from '../call';

/*
 * The workspace mutation gate (B11 Design §7, B9a Design §3, §13's shared-tree seam): what changes
 * the files of a working tree under every agent working in it (a code rewind's restore; B9b's merge
 * and a rebind's Switch are to use it too) runs here, one at a time per tree. A tree is a workspace,
 * or the shared project folder (no workspace), named by its key. Each member of it (an agent whose
 * session runs there, or whose working directory is it, on any canvas the core runs: two canvases
 * may pick one folder) is protected, not only the agent named:
 *
 * - Before anything changes, it refuses while any member may be writing there: a turn going on,
 *   background tasks, or a session whose bounded close didn't finish (its CLI may still run). It
 *   never interrupts their work, never releases their holds, and never waits for a person or for a
 *   turn to end: whoever asked tries again once they are idle.
 * - While it runs, new work for a member (a send, a launch) waits for it to finish (`pass`), so
 *   that nothing starts writing there mid-restore; `holding` says so without waiting. Only a
 *   launch of the agent whose own session makes the change goes past it (its composite reopens
 *   it, and awaits its session); a send to it waits like any other.
 *
 * It holds nothing across a person's decision: a proposal's Allow takes it only once answered.
 */

/** A tree's key: `workspace:<id>`, or `folder:<path>` for the shared project folder. */
export type TreeKey = `workspace:${string}` | `folder:${string}`;

export interface WorkspaceGateDeps {
  /** The canvases the core runs: a tree (the shared project folder) may be several's. */
  canvases: () => readonly CanvasId[];
  /** The agents of a canvas the core runs, in document order (none if it doesn't run it). */
  agents: (canvas: CanvasId) => readonly string[];
  /** The tree an agent's running session works in (as it launched), if one runs. */
  session: (canvas: CanvasId, agent: string) => TreeKey | undefined;
  /**
   * The trees an agent works in: its running session's (as it launched), and its working
   * directory's now, if that is ready (they differ while a rebind waits).
   */
  trees: (canvas: CanvasId, agent: string) => Promise<readonly TreeKey[]>;
  /** Why an agent may be writing now, as a clause ("has a turn going on"), if it may. */
  writing: (canvas: CanvasId, agent: string) => string | undefined;
  /** An agent of a canvas as a refusal on that canvas names it. */
  nameOf: (canvas: CanvasId, agent: string) => string;
}

/** An agent, of a canvas. */
interface Member {
  canvas: CanvasId;
  agent: string;
}

/** How a refusal names an agent of another canvas than the one it is on: never by name. */
const ELSEWHERE = 'an agent on another canvas';

/** A mutation going on: its tree, the agent whose change it is, and when it ends. */
interface Mutation {
  canvas: CanvasId;
  tree: TreeKey;
  agent: string;
  done: Promise<void>;
}

const BUSY =
  'Its files are being changed by another agent’s restore just now: try again once that is done.';
const WAITS = 'Its files are being restored: its new work waits until that is done.';

export class WorkspaceGate {
  readonly #deps: WorkspaceGateDeps;
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(): void { for (const listener of this.#listeners) listener(); }
  /** The mutations going on, by tree (whichever canvas's agents work there). */
  readonly #going = new Map<TreeKey, Mutation>();

  constructor(deps: WorkspaceGateDeps) {
    this.#deps = deps;
  }

  /**
   * Runs `work`, which changes the files of the tree `agent`'s session works in, under the gate:
   * refused (OpFailure, changing nothing) if no session of it runs, another mutation of that tree
   * goes on, or any agent working there (itself too, and those of other canvases) may be writing;
   * otherwise with new work for its members held until it ends. `work` hears who those members of
   * `canvas` are.
   */
  async mutate<T>(
    canvas: CanvasId,
    agent: string,
    work: (members: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const tree = this.#deps.session(canvas, agent);
    if (tree === undefined) {
      throw new OpFailure(
        'unavailable',
        'This agent’s session isn’t running in its working folder.',
      );
    }
    // Unavailable now, not refused: whoever asked (an Allow too) may try again, nothing settled.
    if (this.#going.has(tree)) throw new OpFailure('unavailable', BUSY);
    const ended = Promise.withResolvers<undefined>();
    // Held at once, before the members are read: whatever comes for them meanwhile waits.
    this.#going.set(tree, { canvas, tree, agent, done: ended.promise });
    this.#changed();
    try {
      const everyone = await this.#everyone(tree);
      const others = everyone.filter((one) => one.canvas !== canvas || one.agent !== agent);
      const clauses = [{ canvas, agent }, ...others].flatMap((one) => {
        const why = this.#deps.writing(one.canvas, one.agent);
        if (why === undefined) return [];
        const name = one.canvas === canvas ? this.#deps.nameOf(canvas, one.agent) : ELSEWHERE;
        return [`${name} ${why}`];
      });
      const writing = [...new Set(clauses)];
      if (writing.length > 0) {
        throw new OpFailure(
          'unavailable',
          `Restoring files changes them for every agent working in that folder, and ${andList(writing)}: try again once ${writing.length === 1 ? 'it is' : 'they are'} idle.`,
        );
      }
      return await work(everyone.flatMap((one) => (one.canvas === canvas ? [one.agent] : [])));
    } finally {
      this.#going.delete(tree);
      ended.resolve(undefined);
      this.#changed();
    }
  }

  /**
   * Runs `work`, which changes who works in `trees` (a rebind's Switch, B9a C7), under the gate:
   * refused (OpFailure, changing nothing) if a mutation of any of them goes on, or any agent working
   * in one (those of other canvases too) may be writing; otherwise with new work for every member
   * held until it ends. `work` hears who those members of `canvas` are. No agent is exempt: each
   * member's session is the Switch's to end.
   */
  async drain<T>(
    canvas: CanvasId,
    trees: readonly TreeKey[],
    work: (members: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(trees)];
    if (keys.some((key) => this.#going.has(key))) throw new OpFailure('unavailable', BUSY);
    const ended = Promise.withResolvers<undefined>();
    // Held at once, before the members are read: whatever comes for them meanwhile waits.
    for (const tree of keys)
      this.#going.set(tree, { canvas, tree, agent: '', done: ended.promise });
    this.#changed();
    try {
      const seen = new Set<string>();
      const everyone = (await Promise.all(keys.map((tree) => this.#everyone(tree))))
        .flat()
        .filter((one) => {
          const key = JSON.stringify([one.canvas, one.agent]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const clauses = everyone.flatMap((one) => {
        const why = this.#deps.writing(one.canvas, one.agent);
        if (why === undefined) return [];
        const name = one.canvas === canvas ? this.#deps.nameOf(canvas, one.agent) : ELSEWHERE;
        return [`${name} ${why}`];
      });
      const writing = [...new Set(clauses)];
      if (writing.length > 0) {
        throw new OpFailure(
          'unavailable',
          `Switching changes where every agent of those worktrees works, and ${andList(writing)}: try again once ${writing.length === 1 ? 'it is' : 'they are'} idle.`,
        );
      }
      return await work(everyone.flatMap((one) => (one.canvas === canvas ? [one.agent] : [])));
    } finally {
      for (const key of keys) this.#going.delete(key);
      ended.resolve(undefined);
      this.#changed();
    }
  }

  /** The agents of the canvas working in `tree`: its members, in document order. */
  async members(canvas: CanvasId, tree: TreeKey): Promise<string[]> {
    const agents = this.#deps.agents(canvas);
    const trees = await Promise.all(agents.map((one) => this.#deps.trees(canvas, one)));
    return agents.filter((_one, at) => trees[at]?.includes(tree) === true);
  }

  /** Every agent working in `tree`, on any canvas the core runs. */
  async #everyone(tree: TreeKey): Promise<Member[]> {
    const canvases = this.#deps.canvases();
    const members = await Promise.all(canvases.map((canvas) => this.members(canvas, tree)));
    return canvases.flatMap((canvas, at) =>
      (members[at] ?? []).map((agent) => ({ canvas, agent })),
    );
  }

  /**
   * Resolves once no mutation of a tree `agent` works in goes on: another agent's, and, for a send
   * to it (`own`), its own too (a launch of it goes past its own, which awaits its session).
   */
  async pass(canvas: CanvasId, agent: string, own = false): Promise<void> {
    for (;;) {
      const mutation = await this.#holding(canvas, agent, own);
      if (mutation === undefined) return;
      await mutation.done;
    }
  }

  /** Why new work for `agent` waits now, if it does: another agent's mutation of its tree. */
  async holding(canvas: CanvasId, agent: string): Promise<string | undefined> {
    return (await this.#holding(canvas, agent)) === undefined ? undefined : WAITS;
  }

  async #holding(canvas: CanvasId, agent: string, own = false): Promise<Mutation | undefined> {
    const going = [...this.#going.values()].filter(
      (mutation) => own || mutation.canvas !== canvas || mutation.agent !== agent,
    );
    // Nothing goes on: nothing to read.
    if (going.length === 0) return undefined;
    const trees = await this.#deps.trees(canvas, agent);
    return going.find((mutation) => trees.includes(mutation.tree));
  }
}

/** The tree a working directory binding is: its workspace, else the shared folder. */
export function treeOf({ workspace, cwd }: { workspace: string | null; cwd: string }): TreeKey {
  return workspace === null ? `folder:${cwd}` : `workspace:${workspace}`;
}
