import { randomUUID } from 'node:crypto';

import { connectionIn } from '../../shared/adapter';
import type { AdapterId, Catalog, UsageBackendId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import { fallbackMove } from '../../shared/model/agent-ops';
import type { AgentData, AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { next, sameStep } from '../../shared/model/fallback';
import type {
  Fallback,
  FallbackHeld,
  FallbackPassed,
  FallbackStep,
} from '../../shared/model/fallback';
import { agentParty } from '../../shared/model/messages';
import { nodeKey } from '../../shared/model/rows';
import { resetTime } from '../../shared/model/words';
import type { UsageHold } from '../../shared/usage';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';
import { workspaceSafety } from './canvas/commit';
import { CommitFailed } from './canvas/documents';
import type { Documents, LiveDocument } from './canvas/documents';
import type { Delivery } from './delivery/delivery';
import type { MessageStore, Staged } from './delivery/messages';
import { sentByRun } from './delivery/messages';
import type { Engine } from './engine/engine';
import type { Admission, AdmittedWork } from './engine/run/runner';
import { nameOf } from './parties';

/*
 * B11a's fallback service (C2 to C6, C8): when an agent's usage runs out, or a usage rule says to
 * carry on with the next backend, corrallm switches the agent to the next step of the chain you
 * set, in its document, from a fresh conversation, and its work carries on there; with `back:
 * 'return'`, it switches it back once its own backend can take work again.
 *
 * One admission check (`admit`) runs before automated work starts for an agent: in the run's gate,
 * before a task's attempt goes to its recipient, and in delivery, before a party's message is
 * handed over; never for your own messages. It switches on a backend held exhausted on disk (B8),
 * or a real reading over a fallback rule's share; a simulated reading only says what would happen.
 * Each trigger reads the state of the backend the agent runs on now, so readings repeated, ends
 * duplicated and events late can't move it twice; one lane per agent serializes the rest.
 *
 * The lane (C4), over durable facts, journaling nothing of its own: captured as admission starts
 * it (the agent's revision, its endpoint, its chain's target, why), the work waiting; then it waits
 * for the agent's session to have nothing going (never mid-turn) and holds whatever would start
 * one; checks the agent's workspace; closes its session, waiting for a close that hasn't finished
 * (never forced); forgets the target adapter's remembered conversation (`fresh`, C6); and commits
 * the switch to the agent's document as corrallm, through Documents.change (the only caller beside
 * canvas/commit.ts), checked against the captured revision and workspace-safety, with what C3
 * stages beside it in the same write (`carry`). After every await it checks again that the agent
 * is there at its captured revision, not paused or killed, the barrier not held, and its target
 * able to take work; any change abandons the switch, what was done harmless (a closed session, a
 * forgotten conversation). Once the commit is on disk, the engine follows the document, the
 * transcript says so, a task held on its usage limit continues as one new attempt (C5:
 * `continueAfterSwitch`, no op or caller reaches it), senders whose messages failed on the limit
 * are told once, and what waited goes, on the new endpoint. A crash leaves the document switched or
 * not, which admission decides again from once the run is resumed.
 */

/** A canvas's runtime, as the service reads and changes it (OpenCanvas). */
export interface FallbackRuntime {
  readonly document: CanvasDocument;
  readonly engine: Engine;
  readonly messages: MessageStore;
  readonly delivery: Pick<Delivery, 'schedule'>;
}

export interface FallbackDeps {
  catalog: Catalog;
  /** The adapter an agent naming none runs. */
  defaultAdapter: AdapterId;
  /** The runtime of a canvas the core runs, if it runs it (Engines.canvas). */
  canvas(canvas: CanvasId): FallbackRuntime | undefined;
  /** Each canvas's document: what a switch is committed to, and what tells of commits. */
  documents: Pick<Documents, 'change' | 'loaded' | 'subscribe'>;
  /** The core's sessions: the agent's closed, its target adapter's conversation forgotten. */
  sessions: Pick<SessionManager, 'close' | 'closing' | 'closed' | 'fresh' | 'availability'>;
  /** Every backend's readings, rules and holds (B8). */
  usage: Pick<UsageReadings, 'state' | 'exhausted' | 'durably'>;
  /** The canvas's engine follows its document, after a commit (Engines.changed). */
  changed(canvas: CanvasId): void;
  /** Whether the shutdown barrier holds, or the core closes: nothing switches then. */
  stopping(): boolean;
  /** An agent's switching started or ended: its views say so. */
  switchingChanged?(canvas: CanvasId, agent: string): void;
  /**
   * C3's seam: what a switch's commit stages in its own write (the handoff row's `carry`, set to
   * the switch `change`), so that it is on disk with the switch or neither is. None: nothing.
   */
  carry?(canvas: CanvasId, agent: string, change: string): Staged | undefined;
  now(): number;
  /** The locale times are told in (the host's): the runtime's own, when none. */
  locale?: string;
}

/** Where a switch goes: a step of the chain, or the agent's own endpoint again (null). */
interface Target {
  endpoint: FallbackStep;
  step: number | null;
}

/** A switch going on (C4's lane), from the capture admission made. */
interface Lane {
  canvas: CanvasId;
  agent: string;
  runtime: FallbackRuntime;
  /** This switch's id: what C3's carry names. */
  id: string;
  kind: 'switch' | 'return';
  why: 'usage-limit' | 'rule';
  /** The agent's entity revision as admission captured it: any change since abandons the switch. */
  rev: number;
  from: FallbackStep;
  target: Target;
  passed: readonly FallbackPassed[];
  /** When the switch was admitted: `on.at`. */
  at: number;
  /** Where the agent was in its chain before (`on.at`), if anywhere: senders told since then. */
  since: number;
  /** Resolves (abandoned) or settles the switch: what the agent's session holds for. */
  settled: PromiseWithResolvers<undefined>;
  /** Wakes what the lane waits for, to check again: a change on its canvas. */
  wake: (() => void) | undefined;
  /** Why it was abandoned from outside it (the service closing), if it was. */
  stop?: Abandoned;
  unsubscribe: () => void;
}

/** Why a switch was given up: said to whoever reads what waits, where it holds the agent. */
class Abandoned extends Error {
  /** Whether admission waits for a change of the agent before it tries again (`blocked`). */
  readonly blocks: boolean;
  constructor(why: string, blocks = false) {
    super(why);
    this.name = 'Abandoned';
    this.blocks = blocks;
  }
}

/**
 * A switch that can't be tried again until the agent changes (its revision), or its workspace's
 * availability does: a failed commit, a refused `fresh`, a workspace held.
 */
interface Blocked {
  rev: number;
  sentence: string;
}

/** The agent's revision in a live document: 0 for one it doesn't hold (as canvas/commit.ts). */
function revOf(live: LiveDocument | undefined, agent: string): number {
  const key = nodeKey(agent);
  return live?.rows[key] === undefined ? 0 : (live.revs.get(key) ?? 0);
}

const keyOf = (canvas: CanvasId, agent: string) => JSON.stringify([canvas, agent]);

export class FallbackService {
  readonly #deps: FallbackDeps;
  readonly #lanes = new Map<string, Lane>();
  readonly #blocked = new Map<string, Blocked>();
  /** What each agent's session was told once (a simulated switch, no step left), by its key. */
  readonly #told = new Set<string>();
  #closed = false;

  constructor(deps: FallbackDeps) {
    this.#deps = deps;
  }

  /** Whether corrallm switches the agent's backend now. */
  switching(canvas: CanvasId, agent: string): boolean {
    return this.#lanes.has(keyOf(canvas, agent));
  }

  /**
   * A canvas's availability changed (a workspace became ready): a switch it held is tried again
   * at the next admission.
   */
  availabilityChanged(canvas: CanvasId): void {
    for (const key of [...this.#blocked.keys()])
      if ((JSON.parse(key) as [string, string])[0] === canvas) this.#blocked.delete(key);
  }

  /** The core closes: every switch going on is abandoned, and none starts. */
  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      lane.stop = new Abandoned('corrallm is closing');
      lane.wake?.();
    }
  }

  /**
   * B11a C3's admission, before automated work starts for `agent` on `canvas` (the run's gate, a
   * task held on its usage limit as the run moves, delivery before a party's message): `go` (as it
   * would have gone, or been held, without a chain); `switching`, corrallm switching its backend
   * first; or, for a fallback rule over its share (`work.rule`) that can't switch it, `ask`.
   */
  admit(canvas: CanvasId, agent: string, work: AdmittedWork): Admission {
    const key = keyOf(canvas, agent);
    const lane = this.#lanes.get(key);
    if (lane !== undefined) {
      lane.wake?.();
      return 'switching';
    }
    const otherwise: Admission = work.rule === undefined ? 'go' : 'ask';
    if (this.#closed || this.#deps.stopping()) return otherwise;
    const runtime = this.#deps.canvas(canvas);
    const node = runtime === undefined ? undefined : agentIn(runtime.document, agent);
    if (runtime === undefined || node === undefined) return otherwise;
    const now = this.#deps.now();
    const { engine } = runtime;
    const connection = engine.catalog.connectionOf(node.data);
    if (connection === 'unavailable') return otherwise;
    const chain = node.data.fallback;
    const backend = engine.catalog.usageBackendOf(node.data);
    let why: 'usage-limit' | 'rule';
    if (backend !== undefined && this.#deps.usage.durably(backend, now) !== undefined) {
      why = 'usage-limit';
    } else if (work.rule !== undefined) {
      if (chain === undefined) return 'ask';
      if (this.#simulated(work.rule.backend)) return this.#preview(runtime, node, work.rule, now);
      why = 'rule';
    } else if (
      work.held !== true &&
      chain?.on !== undefined &&
      this.#returns(runtime, chain, now)
    ) {
      return this.#start(canvas, runtime, node, 'return', chain.on.why, {
        endpoint: chain.on.from,
        step: null,
      });
    } else return 'go';
    if (chain === undefined) return otherwise;
    const blocked = this.#blocked.get(key);
    if (blocked !== undefined) {
      if (blocked.rev === revOf(this.#deps.documents.loaded(canvas), agent)) return otherwise;
      this.#blocked.delete(key);
    }
    const walk = this.#walk(runtime, node, now);
    if ('none' in walk) {
      if (why === 'rule') this.#tellNone(runtime, node, walk.none, work.rule);
      return otherwise;
    }
    return this.#start(canvas, runtime, node, 'switch', why, walk.target, walk.passed);
  }

  /**
   * What a task held on `agent`'s usage limit says of its fallback chain (C3), if it has one:
   * that it didn't act, corrallm not knowing when the limit ends (no hold on disk); why a switch
   * couldn't be made; or that no step is left, each with when it can take work. Nothing where it
   * switches.
   */
  limitNote(canvas: CanvasId, agent: string): string | undefined {
    const runtime = this.#deps.canvas(canvas);
    const node = runtime === undefined ? undefined : agentIn(runtime.document, agent);
    if (runtime === undefined || node?.data.fallback === undefined) return undefined;
    if (this.#lanes.has(keyOf(canvas, agent))) return undefined;
    const now = this.#deps.now();
    const backend = runtime.engine.catalog.usageBackendOf(node.data);
    if (backend === undefined) return undefined;
    if (this.#deps.usage.durably(backend, now) === undefined) {
      return this.#deps.usage.exhausted(backend, now) === undefined
        ? 'Its fallback chain didn’t act: corrallm can’t tell when this limit ends.'
        : 'Its fallback chain didn’t act: corrallm couldn’t keep this limit on disk.';
    }
    const blocked = this.#blocked.get(keyOf(canvas, agent));
    if (blocked?.rev === revOf(this.#deps.documents.loaded(canvas), agent)) return blocked.sentence;
    const walk = this.#walk(runtime, node, now);
    return 'none' in walk ? this.#noneText(runtime, node, walk.none) : undefined;
  }

  /** Whether a reading of `backend` that a rule reads is simulated (Simulate usage…). */
  #simulated(backend: UsageBackendId): boolean {
    return this.#deps.usage
      .state()
      .readings.some((reading) => reading.backend === backend && reading.simulated === true);
  }

  /**
   * C3: a simulated reading over a fallback rule switches nothing: the agent's session is told,
   * once a window, what would happen. With a step to go to, the work goes as it is; with none, the
   * rule asks, as it would for real.
   */
  #preview(runtime: FallbackRuntime, node: AgentNode, rule: UsageHold, now: number): Admission {
    const walk = this.#walk(runtime, node, now);
    const told = JSON.stringify([
      runtime.document.id,
      node.id,
      'simulated',
      rule.backend,
      rule.window,
      rule.resetsAt,
    ]);
    if (!this.#told.has(told)) {
      this.#told.add(told);
      const name = nameOf(runtime.document.nodes, node.id);
      const text =
        'none' in walk
          ? `Simulated: ${name} would have no backend left to carry on with.`
          : `Simulated: ${name} would carry on with ${this.#endpointName(walk.target.endpoint)}.`;
      this.#tell(runtime, node.id, 'info', text);
    }
    return 'none' in walk ? 'ask' : 'go';
  }

  /** The walk (pure, shared/model/fallback.ts) over the backends held now. */
  #walk(
    runtime: FallbackRuntime,
    node: AgentNode,
    now: number,
  ): { target: Target; passed: readonly FallbackPassed[] } | { none: readonly FallbackPassed[] } {
    const chain = node.data.fallback;
    if (chain === undefined) return { none: [] };
    const current = this.#endpoint(runtime, node.data);
    // C1a's edge: an agent whose own endpoint you made one of its steps, on none yet, keeps no
    // place to come back to that the chain can hold (its steps and its own endpoint are distinct):
    // the chain doesn't act until that step is removed from it.
    if (chain.on === undefined && chain.to.some((step) => sameStep(step, current)))
      return { none: [] };
    const walked = next(
      {
        ...node.data,
        adapter: current?.adapter ?? this.#deps.defaultAdapter,
        connection: current?.connection ?? 'unavailable',
      },
      this.#deps.catalog,
      this.#held(runtime, now),
    );
    if ('none' in walked) return walked;
    const index = chain.to.findIndex((step) => sameStep(step, walked.step));
    return {
      target: { endpoint: walked.step, step: index === -1 ? null : index },
      passed: walked.passed,
    };
  }

  /** The agent's endpoint as its document names it now. */
  #endpoint(runtime: FallbackRuntime, data: AgentData): FallbackStep | undefined {
    const adapter = data.adapter ?? this.#deps.defaultAdapter;
    const connection = runtime.engine.catalog.connectionOf(data);
    if (connection === 'unavailable') return undefined;
    const settings =
      data.settings && Object.hasOwn(data.settings, adapter) ? data.settings[adapter] : {};
    return {
      adapter,
      connection,
      ...(settings?.model === undefined ? {} : { model: settings.model }),
      ...(settings?.effort === undefined ? {} : { effort: settings.effort }),
    };
  }

  /**
   * The backends a walk passes by now: held exhausted (on disk or not: B8 holds either way), or
   * held by their rule, any action but warn, over its share on a real reading.
   */
  #held(runtime: FallbackRuntime, now: number): Map<UsageBackendId, FallbackHeld> {
    const held = new Map<UsageBackendId, FallbackHeld>();
    for (const { id } of this.#deps.catalog.usageBackends) {
      const until = this.#deps.usage.exhausted(id, now);
      if (until !== undefined) {
        held.set(id, { why: 'usage-limit', resetsAt: until });
        continue;
      }
      const rule = runtime.engine.run.backendRule(id, now);
      if (rule !== undefined && rule.action !== 'warn' && rule.simulated !== true)
        held.set(id, { why: 'rule', resetsAt: rule.hold.resetsAt });
    }
    return held;
  }

  /**
   * C8: whether an agent on a step of a chain that returns can switch back to its own endpoint
   * now: that endpoint runnable, its backend not held exhausted, no rule (but warn) over its share
   * on a real reading, and, for a rule's switch, a reading of it at all (a missing reading is no
   * evidence of room).
   */
  #returns(runtime: FallbackRuntime, chain: Fallback, now: number): boolean {
    if (chain.back !== 'return' || chain.on === undefined) return false;
    return this.#takes(runtime, chain.on.from, now, chain.on.why);
  }

  /** Whether `endpoint` can take work now: what a switch to it, or a return, checks again. */
  #takes(
    runtime: FallbackRuntime,
    endpoint: FallbackStep,
    now: number,
    why?: 'usage-limit' | 'rule',
  ): boolean {
    const found = connectionIn(this.#deps.catalog, endpoint.connection);
    if (found?.adapter.id !== endpoint.adapter) return false;
    const backend = found.connection.usage;
    if (backend === null) return true;
    if (this.#deps.usage.exhausted(backend, now) !== undefined) return false;
    const reading = this.#deps.usage.state().readings.find((one) => one.backend === backend);
    if (reading?.simulated === true) return why === undefined;
    const rule = runtime.engine.run.backendRule(backend, now);
    if (rule !== undefined && rule.action !== 'warn' && rule.simulated !== true) return false;
    return why !== 'rule' || reading !== undefined;
  }

  /** Starts a switch's lane, from what admission captured: the work waits, shown as switching. */
  #start(
    canvas: CanvasId,
    runtime: FallbackRuntime,
    node: AgentNode,
    kind: 'switch' | 'return',
    why: 'usage-limit' | 'rule',
    target: Target,
    passed: readonly FallbackPassed[] = [],
  ): Admission {
    const from = this.#endpoint(runtime, node.data);
    if (from === undefined) return 'go';
    const settled = Promise.withResolvers<undefined>();
    // Its rejection is the lane's own to say: nothing else waits for it.
    settled.promise.catch(() => undefined);
    const lane: Lane = {
      canvas,
      agent: node.id,
      runtime,
      id: randomUUID(),
      kind,
      why,
      rev: revOf(this.#deps.documents.loaded(canvas), node.id),
      from,
      target,
      passed,
      at: this.#deps.now(),
      since: node.data.fallback?.on?.at ?? 0,
      settled,
      wake: undefined,
      unsubscribe: () => undefined,
    };
    const wake = () => {
      lane.wake?.();
    };
    const stops = [
      runtime.engine.run.subscribe(wake),
      runtime.engine.sessions.subscribe(wake),
      this.#deps.documents.subscribe((commit) => {
        if (commit.canvas === canvas) wake();
      }),
    ];
    lane.unsubscribe = () => {
      for (const stop of stops) stop();
    };
    this.#lanes.set(keyOf(canvas, node.id), lane);
    this.#deps.switchingChanged?.(canvas, node.id);
    void this.#run(lane).then(
      () => undefined,
      (error: unknown) => {
        this.#abandoned(lane, error);
      },
    );
    return 'switching';
  }

  /** The lane (C4), each await followed by its checks. */
  async #run(lane: Lane): Promise<void> {
    const { canvas, agent, runtime } = lane;
    const { sessions } = this.#deps;
    // Never in the middle of a turn: once its session has nothing going, nothing asked, nothing
    // queued and nothing on its way from the run, whatever would start one waits for the switch,
    // from that same moment.
    await this.#until(
      lane,
      () => this.#idle(lane),
      () => {
        runtime.engine.sessions.switching(agent, lane.settled.promise);
      },
    );
    // C3's seam, here: a handoff request waiting for the agent goes first, unless its backend is
    // exhausted, and the switch is admitted again after its turn (not built in C2).
    // Never while its workspace is held.
    const availability = await sessions.availability(canvas, agent);
    this.#check(lane);
    if (!availability.ready) throw new Abandoned(availability.sentence, true);
    // Close the source: the engine's driver, then any session the manager runs for it.
    await runtime.engine.sessions.close(agent);
    this.#check(lane);
    await sessions.close(canvas, agent);
    this.#check(lane);
    // A close that hasn't finished keeps its claim: the switch waits for it, never forcing it.
    while (sessions.closing(canvas, agent)) {
      await this.#wait(lane, sessions.closed(canvas, agent));
      this.#check(lane);
    }
    // C6: a fresh conversation, so that its lazy start never resumes an unrelated old one.
    try {
      await sessions.fresh(canvas, agent, lane.target.endpoint.adapter);
    } catch (error) {
      this.#check(lane);
      throw new Abandoned(
        `corrallm couldn’t start ${this.#endpointName(lane.target.endpoint)} afresh: ${messageOf(error)}`,
        true,
      );
    }
    this.#check(lane);
    await this.#commit(lane);
    this.#after(lane);
  }

  /** Whether the agent's session has nothing going that a close would cut short. */
  #idle({ agent, runtime }: Lane): boolean {
    const session = runtime.engine.sessions.of(agent);
    return (
      session.status === 'idle' &&
      session.queued.length === 0 &&
      (session.asking?.length ?? 0) === 0 &&
      !runtime.engine.run.sending(agent)
    );
  }

  /**
   * Waits, checking again at each change on the canvas, until `ready` says so; then does `then`
   * in the same step, nothing between.
   */
  async #until(lane: Lane, ready: () => boolean, then: () => void): Promise<void> {
    for (;;) {
      this.#check(lane);
      if (ready()) {
        then();
        return;
      }
      await this.#wait(lane, new Promise<never>(() => undefined));
    }
  }

  /** Waits for `promise`, or the next change on the canvas, whichever comes first. */
  async #wait(lane: Lane, promise: Promise<unknown>): Promise<void> {
    const woken = Promise.withResolvers<undefined>();
    lane.wake = () => {
      woken.resolve(undefined);
    };
    try {
      await Promise.race([promise, woken.promise]);
    } finally {
      lane.wake = undefined;
    }
  }

  /**
   * C4's checks, after every await: the agent there at its captured revision, not paused or
   * killed, the barrier not held, its canvas still the one the core runs, and its target able to
   * take work. Throws, abandoning the switch, if any fails.
   */
  #check(lane: Lane): void {
    if (lane.stop) throw lane.stop;
    if (this.#closed || this.#deps.stopping())
      throw new Abandoned('corrallm is stopping: the switch is decided again as it starts');
    if (this.#deps.canvas(lane.canvas) !== lane.runtime) throw new Abandoned('Its canvas closed');
    const live = this.#deps.documents.loaded(lane.canvas);
    if (live === undefined || agentIn(live.document, lane.agent) === undefined)
      throw new Abandoned('The agent is gone');
    if (revOf(live, lane.agent) !== lane.rev)
      throw new Abandoned('The agent changed: admission decides again');
    if (lane.runtime.engine.run.holding({ agent: lane.agent }).length > 0)
      throw new Abandoned('The agent is paused');
    const now = this.#deps.now();
    if (
      !this.#takes(
        lane.runtime,
        lane.target.endpoint,
        now,
        lane.kind === 'return' ? lane.why : undefined,
      )
    )
      throw new Abandoned('Its target can’t take work now: admission decides again');
  }

  /**
   * C4.5: commits the switch to the agent's document as corrallm (`fallback.switch`, or
   * `fallback.return`), checked against the captured revision, the barrier and workspace-safety,
   * with C3's carry in the same write.
   */
  async #commit(lane: Lane): Promise<void> {
    const { canvas, agent } = lane;
    const deps = this.#deps;
    try {
      await this.#deps.documents.change(canvas, {
        revision: {
          op: lane.kind === 'return' ? 'fallback.return' : 'fallback.switch',
          by: 'corrallm',
        },
        build: (document) => {
          if (agentIn(document, agent) === undefined) throw new Abandoned('The agent is gone');
          return fallbackMove(
            document,
            { agent, step: lane.target.step, why: lane.why, at: lane.at },
            { catalog: this.#deps.catalog, defaultAdapter: this.#deps.defaultAdapter },
          );
        },
        check: (_change, live, losses) => {
          if (this.#closed || this.#deps.stopping())
            throw new Abandoned('corrallm is stopping: the switch is decided again as it starts');
          if (revOf(live, agent) !== lane.rev)
            throw new Abandoned('The agent changed: admission decides again');
          const safety = workspaceSafety(losses?.trees ?? [], undefined);
          if (safety.propose !== undefined) throw new Abandoned(safety.propose, true);
          return safety.removals;
        },
        committing: () => undefined,
        ...(deps.carry === undefined
          ? {}
          : { within: () => deps.carry?.(canvas, agent, lane.id) ?? NOTHING }),
      });
    } catch (error) {
      if (error instanceof Abandoned) throw error;
      // C4: a commit that fails (CommitFailed, a store failed closed, a refused change): no switch.
      throw new Abandoned(
        `corrallm couldn’t save its switch to ${this.#endpointName(lane.target.endpoint)}${
          error instanceof CommitFailed ? '' : ` (${messageOf(error)})`
        }, so it stays on ${this.#endpointName(lane.from)}.`,
        true,
      );
    }
  }

  /**
   * C4.6, once the commit is on disk: the engine follows the document, then what the agent's
   * session held goes there; the transcript says what happened; a task held on the limit continues
   * (C5); senders whose messages failed on it are told once; the run and delivery look again.
   */
  #after(lane: Lane): void {
    const { canvas, agent, runtime } = lane;
    this.#deps.changed(canvas);
    this.#end(lane);
    lane.settled.resolve(undefined);
    const name = nameOf(runtime.document.nodes, agent);
    const target = this.#endpointName(lane.target.endpoint);
    this.#tell(runtime, agent, 'info', this.#switchText(lane, name, target));
    if (lane.kind === 'switch' && lane.why === 'usage-limit') {
      for (const [owner, at] of Object.entries(runtime.engine.run.snapshot().agents)) {
        const last = at.current === undefined ? undefined : at.attempts?.[at.current]?.at(-1);
        if (
          at.problem?.kind === 'failed' &&
          at.problem.reason === 'usage-limit' &&
          at.problem.agent === agent &&
          at.current !== undefined &&
          last !== undefined
        )
          runtime.engine.run.continueAfterSwitch(owner, at.current, last.id);
      }
    }
    this.#tellSenders(lane, name, target);
    runtime.engine.run.admissionChanged();
    runtime.delivery.schedule();
  }

  /** What the transcript says of a switch: where to, why, what it passed by, nothing sent again. */
  #switchText(lane: Lane, name: string, target: string): string {
    const backend = this.#backendOf(lane.from);
    const said =
      lane.kind === 'return'
        ? `${name} is back on ${target}: ${this.#backendOf(lane.target.endpoint) ?? 'it'} can take work again.`
        : lane.why === 'usage-limit'
          ? `${name} carries on with ${target}: ${backend === undefined ? 'its usage' : `${backend}’s usage`} ran out${this.#untilText(lane.from)}.`
          : `${name} carries on with ${target}: ${backend === undefined ? 'its usage' : `${backend}’s usage`} is over its rule’s share.`;
    const passed =
      lane.passed.length === 0 ? '' : ` It passed by ${this.#passedText(lane.passed)}.`;
    return `${said}${passed} It starts a new conversation there; nothing already sent is sent again.`;
  }

  /**
   * C5: each party whose message's turn on the agent failed on the limit (since the agent's last
   * switch) is told once that it carries on elsewhere, its message not sent again.
   */
  #tellSenders(lane: Lane, name: string, target: string): void {
    const store = lane.runtime.messages;
    const replies = store
      .all()
      .filter(
        (message) =>
          message.from === agentParty(lane.agent) &&
          message.replyTo !== undefined &&
          message.turn?.status === 'failed' &&
          message.turn.reason === 'usage-limit' &&
          message.at >= lane.since,
      );
    let told = false;
    for (const reply of replies) {
      const original = reply.replyTo === undefined ? undefined : store.get(reply.replyTo);
      if (
        original === undefined ||
        sentByRun(original) ||
        original.from === 'you' ||
        original.from === 'corrallm' ||
        store.hasTold(`carries-on:${original.id}`)
      )
        continue;
      store.add(
        {
          from: 'corrallm',
          to: original.from,
          kind: 'notice',
          origin: 'party',
          body: `${name} carries on with ${target}; your message wasn’t sent again.`,
          replyTo: original.id,
          state: 'delivered',
        },
        `carries-on:${original.id}`,
      );
      told = true;
    }
    if (told)
      void store.durable().catch((error: unknown) => {
        console.error('Could not keep what corrallm told the senders of a switch:', error);
      });
  }

  /** A switch given up: the work goes on as admission decides next; a block waits for a change. */
  #abandoned(lane: Lane, error: unknown): void {
    if (this.#lanes.get(keyOf(lane.canvas, lane.agent)) !== lane) return;
    this.#end(lane);
    lane.settled.reject(error);
    // What wasn't foreseen is said, and waits for a change as a refusal does: never tried again
    // in a loop.
    const unforeseen = !(error instanceof Abandoned);
    if (unforeseen) console.error('A backend switch failed:', error);
    const sentence = unforeseen
      ? `corrallm couldn’t switch it to ${this.#endpointName(lane.target.endpoint)}: ${messageOf(error)}`
      : error.message;
    if (unforeseen || error.blocks) {
      this.#blocked.set(keyOf(lane.canvas, lane.agent), { rev: lane.rev, sentence });
      // What holds the agent says why the switch wasn't made.
      this.#tell(lane.runtime, lane.agent, 'warning', sentence);
    }
    if (this.#deps.canvas(lane.canvas) === lane.runtime && !this.#closed) {
      lane.runtime.engine.run.admissionChanged();
      lane.runtime.delivery.schedule();
    }
  }

  /** The lane ends: its agent no longer switching. */
  #end(lane: Lane): void {
    const key = keyOf(lane.canvas, lane.agent);
    if (this.#lanes.get(key) !== lane) return;
    this.#lanes.delete(key);
    lane.unsubscribe();
    lane.wake = undefined;
    this.#deps.switchingChanged?.(lane.canvas, lane.agent);
  }

  /**
   * C3: a fallback rule's switch with no step left: the agent's session is told, once a window,
   * each step and when it can take work; the rule asks, as ask does.
   */
  #tellNone(
    runtime: FallbackRuntime,
    node: AgentNode,
    passed: readonly FallbackPassed[],
    rule: UsageHold | undefined,
  ): void {
    const told = JSON.stringify([
      runtime.document.id,
      node.id,
      'none',
      rule?.backend,
      rule?.window,
      rule?.resetsAt,
    ]);
    if (this.#told.has(told)) return;
    this.#told.add(told);
    this.#tell(runtime, node.id, 'warning', this.#noneText(runtime, node, passed));
  }

  #noneText(runtime: FallbackRuntime, node: AgentNode, passed: readonly FallbackPassed[]): string {
    const chain = node.data.fallback;
    const current = this.#endpoint(runtime, node.data);
    if (
      chain?.on === undefined &&
      current !== undefined &&
      chain?.to.some((step) => sameStep(step, current)) === true
    )
      // agent.setFallback refuses a chain naming the agent's own endpoint: removing that step,
      // not saving the chain again, is what lets it act.
      return `Its fallback chain didn’t act: this agent’s backend, ${this.#endpointName(current)}, is now one of its fallback steps. Removing that step from its chain lets the chain act again.`;
    return passed.length === 0
      ? 'No backend in its fallback chain can take work now.'
      : `No backend in its fallback chain can take work now: ${this.#passedText(passed)}.`;
  }

  /** Each step a walk passed by, and why, in words. */
  #passedText(passed: readonly FallbackPassed[]): string {
    return passed
      .map(({ step, why, resetsAt }) => {
        const where = this.#endpointName(step);
        const until =
          resetsAt === undefined || resetsAt === null
            ? ''
            : ` until ${resetTime(resetsAt, this.#deps.now(), this.#deps.locale)}`;
        switch (why) {
          case 'already-on':
            return `${where} (it runs on it already)`;
          case 'unavailable':
            return `${where} (this corrallm can’t run it)`;
          case 'usage-limit':
            return `${where} (out of usage${until})`;
          case 'rule':
            return `${where} (its usage rule holds it${until})`;
        }
      })
      .join(', ');
  }

  /** An endpoint as the transcript names it: its connection, then its model and effort. */
  #endpointName({ connection, model, effort }: FallbackStep): string {
    const found = connectionIn(this.#deps.catalog, connection);
    const named =
      found === undefined ? connection : `${found.adapter.name} · ${found.connection.label}`;
    const settings = [model, effort].filter((one) => one !== undefined);
    return settings.length === 0 ? named : `${named} (${settings.join(', ')})`;
  }

  /** The usage backend an endpoint spends, as named: none for one that spends none. */
  #backendOf({ connection }: FallbackStep): string | undefined {
    const backend = connectionIn(this.#deps.catalog, connection)?.connection.usage;
    if (backend === undefined || backend === null) return undefined;
    return this.#deps.catalog.usageBackends.find((one) => one.id === backend)?.label ?? backend;
  }

  /** Until when the backend an endpoint spends is held, in words: nothing where it isn't. */
  #untilText({ connection }: FallbackStep): string {
    const backend = connectionIn(this.#deps.catalog, connection)?.connection.usage;
    const until =
      backend === undefined || backend === null
        ? undefined
        : this.#deps.usage.exhausted(backend, this.#deps.now());
    return until === undefined
      ? ''
      : ` until ${resetTime(until, this.#deps.now(), this.#deps.locale)}`;
  }

  /** A notice in the agent's transcript, told once its current work has been decided. */
  #tell(runtime: FallbackRuntime, agent: string, level: 'info' | 'warning', text: string): void {
    queueMicrotask(() => {
      if (this.#deps.canvas(runtime.document.id) !== runtime) return;
      if (agentIn(runtime.document, agent) === undefined) return;
      runtime.engine.sessions.notice(agent, level, text);
    });
  }
}

/** Nothing staged beside a commit. */
const NOTHING: Staged = { reveal: () => undefined, undo: () => undefined };

function agentIn(document: CanvasDocument, agent: string): AgentNode | undefined {
  const node = document.nodes.find((one) => one.id === agent);
  return node?.type === 'agent' ? node : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
