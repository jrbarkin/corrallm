import { randomBytes, randomUUID } from 'node:crypto';

import { connectionIn } from '../../shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../../shared/adapter';
import { MAX_HANDOFF_BYTES } from '../../shared/api/limits';
import type { CanvasId } from '../../shared/canvas';
import { startsWithShell } from '../../shared/model/catalog';
import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { askPoint } from '../../shared/model/fallback';
import type { SessionContext } from '../../shared/model/fallback';
import type { Handoff, HandoffSource, HandoffTask, HandoffView } from '../../shared/model/handoff';
import { agentOf, agentParty } from '../../shared/model/messages';
import type { Message } from '../../shared/model/messages';
import type { TurnResult } from '../../shared/session';
import type { UsageReadings } from '../usage';
import type { Delivery } from './delivery/delivery';
import { HANDOFF_CARRIED, HANDOFF_REQUEST } from './delivery/delivery';
import type { CarryWhy, HandoffStore } from './delivery/handoffs';
import type { HandoffExporter } from './handoff-file';
import type { MessageStore, Staged } from './delivery/messages';
import type { Engine } from './engine/engine';
import type { SessionAction } from './engine/transcript/reduce';
import { quotedParty } from './parties';

/*
 * B11a's handoff service (Design §12 C7, C10): once an agent's reported context passes its ask
 * point, corrallm asks the agent itself to write its handoff, and keeps the exact reply as its
 * latest; the first automated send after a backend switch carries it to the next backend. corrallm
 * never writes a handoff, and never summarizes history: the user's decision, October 20.
 *
 * - **Arming** (in memory): an agent is armed at first, and again whenever its session reports a
 *   context under its ask point (C7a: `askPoint`, the smaller of its share of the window and 20,000
 *   tokens before where its CLI compacts); an accepted handoff disarms it. A restart re-arms.
 * - **Asking**: at the end of any turn, whoever sent it, whose last report in that turn is at or
 *   above the ask point, an armed agent whose handoff isn't off, on a connection whose descriptor
 *   says it reports its context (`ConnectionDescriptor.context`), whose backend isn't held
 *   exhausted, is sent corrallm's request through delivery (`Delivery.ask`): recorded before it is
 *   sent, first in line, held by what holds the agent (but never its asking mode), never admitted
 *   as work; while it waits or runs, the run's gate holds the agent's next task (RunIO.handoff), and
 *   a switch waits for it unless its backend is exhausted (FallbackDeps.handoffFirst). At most twice
 *   a crossing; then its state is failed until it re-arms.
 * - **Accepting**: the request's turn completed, its reply, trimmed, not empty and at most 16 KiB
 *   of UTF-8: kept exactly, as the agent's latest, in the write that records the reply. Anything
 *   else keeps the previous one. Then, with a Markdown file set, its exact text is exported
 *   (handoff-file.ts).
 * - **Carrying**: a switch's commit stages its carry (`stage`); the first automated send to the
 *   agent after it (a run attempt, a party's message) takes it (`carry`), framed: corrallm's switch
 *   line, the task or the party's framed message, then the handoff between lines holding a random
 *   nonce, labeled with the CLI that wrote it, when and the task it was on; or a line saying none
 *   was written. The write that records that send clears the carry.
 */

/** A canvas's runtime, as the service reads and changes it (OpenCanvas). */
export interface HandoffRuntime {
  readonly document: CanvasDocument;
  readonly engine: Engine;
  readonly messages: MessageStore;
  readonly delivery: Pick<Delivery, 'schedule' | 'ask' | 'stuck'>;
  readonly handoffs: HandoffStore;
}

export interface HandoffDeps {
  catalog: Catalog;
  /** The runtime of a canvas the core runs, if it runs it. */
  canvas(canvas: CanvasId): HandoffRuntime | undefined;
  /** Every backend's hard limits (B8): an exhausted backend's agent is never asked. */
  usage: Pick<UsageReadings, 'exhausted'>;
  /** Whether corrallm switches the agent's backend now (the fallback service's lane). */
  switching?(canvas: CanvasId, agent: string): boolean;
  /** The Markdown export, where an agent's handoff settings name a file (C10). */
  exporter?: HandoffExporter;
  /** An agent's handoff view changed: its summary says it again. */
  changed?(canvas: CanvasId, agent: string): void;
  now(): number;
}

/** The share of its window an agent's handoff is asked at, where its settings say none (C7). */
export const HANDOFF_AT = 95;
/** The most requests a crossing makes before its state is failed (C7). */
const TRIES = 2;

/** corrallm's request, as it waits or runs: its message, and the session it was asked of. */
interface Request {
  id: string;
  adapter: AdapterId;
  connection: ConnectionId;
  during?: HandoffTask;
}

/** An agent's handoff, as the service follows it (in memory). */
interface Following {
  armed: boolean;
  /** Requests made since it was last armed. */
  asked: number;
  /** Its requests this crossing weren't accepted: the view says so until it re-arms. */
  failed: boolean;
  /**
   * A turn's report reached its ask point since it was last armed: a switch with no handoff kept
   * says its context reached it but none was accepted, not that it never did.
   */
  crossed: boolean;
  /** Its session's last context report since its last turn ended. */
  report: SessionContext | undefined;
  request: Request | undefined;
}

interface Attached {
  runtime: HandoffRuntime;
  agents: Map<string, Following>;
  exports: Map<string, Promise<void>>;
  stop: () => void;
}

export class HandoffService {
  readonly #deps: HandoffDeps;
  readonly #canvases = new Map<CanvasId, Attached>();

  constructor(deps: HandoffDeps) {
    this.#deps = deps;
  }

  /**
   * A canvas's runtime opened: the service hears its sessions' reports and turn ends, and the end
   * of each request it makes, until the returned function is called (the canvas stops).
   */
  attach(canvas: CanvasId, runtime: HandoffRuntime): () => void {
    this.#canvases.get(canvas)?.stop();
    const stops = [
      runtime.engine.sessions.observe((agent, action) => {
        this.#observed(canvas, agent, action);
      }),
      runtime.messages.watch((id) => {
        this.#watched(canvas, id);
      }),
    ];
    const attached: Attached = {
      runtime,
      agents: new Map(),
      exports: new Map(),
      stop: () => {
        for (const stop of stops) stop();
        if (this.#canvases.get(canvas) === attached) this.#canvases.delete(canvas);
      },
    };
    this.#canvases.set(canvas, attached);
    return attached.stop;
  }

  /** Whether corrallm's handoff request to the agent waits or runs: its next task waits. */
  asking(canvas: CanvasId, agent: string): boolean {
    return this.#following(canvas, agent)?.request !== undefined;
  }

  /**
   * C4.2: whether a switch of the agent waits for its handoff request to go first: one waits or
   * runs, and its backend isn't exhausted (then it is withdrawn instead), nor its session one that
   * won't start (the switch is what lets it run again).
   */
  first(canvas: CanvasId, agent: string): boolean {
    const attached = this.#canvases.get(canvas);
    const request = attached?.agents.get(agent)?.request;
    if (attached === undefined || request === undefined) return false;
    if (this.#exhausted(attached.runtime, agent)) return false;
    return !attached.runtime.delivery.stuck().some((one) => one.agent === agent);
  }

  /**
   * Delivery's question about one of corrallm's handoff requests waiting (by its told key): `go`,
   * the agent's current request, asked of the session it runs now; `hold`, while corrallm switches
   * its backend; `stale`, to be withdrawn: one this service didn't make since the canvas opened (a
   * restart re-arms), an agent whose handoff is off now, whose connection changed, or whose
   * backend is held exhausted.
   */
  request(canvas: CanvasId, message: Message): 'go' | 'hold' | 'stale' {
    const attached = this.#canvases.get(canvas);
    const agent = agentOf(message.to);
    if (attached === undefined || agent === undefined) return 'stale';
    const request = attached.agents.get(agent)?.request;
    const node = agentIn(attached.runtime.document, agent);
    if (request?.id !== message.id || node === undefined || node.data.handoff?.off === true)
      return 'stale';
    if (attached.runtime.engine.catalog.connectionOf(node.data) !== request.connection)
      return 'stale';
    if (this.#exhausted(attached.runtime, agent)) return 'stale';
    return this.#deps.switching?.(canvas, agent) === true ? 'hold' : 'go';
  }

  /**
   * A handoff request's turn ended (delivery, as it records the reply: the same write holds what
   * this keeps). Accepted, its turn completed and its reply, trimmed, neither empty nor over
   * MAX_HANDOFF_BYTES: kept exactly as the agent's latest, the agent disarmed, then exported
   * where its settings say. Anything else keeps the previous one, the agent still armed.
   */
  replied(canvas: CanvasId, message: Message, reply: string, result: TurnResult): void {
    const attached = this.#canvases.get(canvas);
    const agent = agentOf(message.to);
    if (attached === undefined || agent === undefined) return;
    const following = attached.agents.get(agent);
    const request = following?.request;
    if (following === undefined || request?.id !== message.id) return;
    const { runtime } = attached;
    const text = reply.trim();
    const bytes = Buffer.byteLength(text);
    this.#changed(canvas, agent);
    if (result.status !== 'completed' || text === '' || bytes > MAX_HANDOFF_BYTES) {
      if (following.asked >= TRIES) following.failed = true;
      return;
    }
    const model = runtime.engine.sessions.of(agent).model;
    const source: HandoffSource = {
      adapter: request.adapter,
      connection: request.connection,
      ...(model === null || model === '' ? {} : { model }),
    };
    const handoff: Handoff = {
      text,
      at: this.#deps.now(),
      source,
      ...(request.during === undefined ? {} : { during: request.during }),
      bytes,
    };
    runtime.handoffs.accept(agent, handoff);
    following.armed = false;
    following.asked = 0;
    following.failed = false;
    // Once delivery has recorded the reply in this same tick: their one write holds both.
    queueMicrotask(() => {
      this.#queueExport(canvas, attached, agent, handoff);
    });
  }

  /**
   * C4.5: within a switch's commit write, the agent's carry set to that switch (`change`), on
   * disk with the switch or neither is.
   */
  stage(canvas: CanvasId, agent: string, change: string): Staged | undefined {
    const runtime = this.#deps.canvas(canvas);
    if (runtime === undefined) return undefined;
    // Its document as it is before the switch commits: why it has no handoff, if it hasn't one.
    const why =
      runtime.handoffs.of(agent)?.handoff === undefined
        ? this.#whyNone(canvas, runtime, agent)
        : undefined;
    return runtime.handoffs.stageCarry(agent, change, why);
  }

  /**
   * Why an agent has no handoff, as a switch from its backend is made: its handoffs are off, its
   * connection reports no context, its context reached its ask point but none was accepted, or it
   * never reached it.
   */
  #whyNone(canvas: CanvasId, runtime: HandoffRuntime, agent: string): CarryWhy {
    const node = agentIn(runtime.document, agent);
    if (node?.data.handoff?.off === true) return 'off';
    if (node === undefined || !this.#reports(runtime, node)) return 'unreported';
    return this.#following(canvas, agent)?.crossed === true ? 'unaccepted' : 'reached';
  }

  /**
   * The first automated send to the agent since a switch carries its handoff (C7): `text`, a run
   * attempt's task as given (`run`) or a party's message as delivery frames it (`party`), framed
   * with corrallm's switch line before it and the handoff (or a line saying none was written)
   * after it. The carry is taken now: the write that records the send clears it; `undo` puts it
   * back where that send was never made. Undefined where nothing waits to be carried, and for a
   * run's text that is a slash command or starts with a shell prefix, which goes as it is (the
   * next send carries it).
   */
  carry(
    canvas: CanvasId,
    agent: string,
    text: string,
    kind: 'run' | 'party',
    owner?: string,
  ): { text: string; carry: string; undo: () => void } | undefined {
    const runtime = this.#deps.canvas(canvas);
    const node = runtime === undefined ? undefined : agentIn(runtime.document, agent);
    if (runtime === undefined || node === undefined) return undefined;
    if (runtime.handoffs.of(agent)?.carry === undefined) return undefined;
    if (
      kind === 'run' &&
      (text.trimStart().startsWith('/') ||
        runtime.engine.catalog.shellPrefixes.some((prefix) => startsWithShell(text, prefix)))
    )
      return undefined;
    const taken = runtime.handoffs.take(agent);
    if (taken === undefined) return undefined;
    const framed = [
      this.#switchLine(runtime, node),
      kind === 'run' && owner !== undefined && owner !== agent
        ? `[corrallm] This task is from agent ${quotedParty(runtime.document.nodes, agentParty(owner))} (another agent, not the user or corrallm):\n${text}`
        : text,
      this.#handoffBlock(runtime, node, taken.handoff, taken.why),
    ].join('\n\n');
    return {
      text: framed,
      carry: taken.carry,
      undo: () => {
        runtime.handoffs.untake(agent, taken.carry);
      },
    };
  }

  /**
   * As a canvas's delivery starts: each send that took a carry (kept with a told key starting
   * HANDOFF_CARRIED) and was cut off unresolved before its session had it, by a crash or a close,
   * leaves that carry to the next automated send; its record no longer says it carried one, in
   * the same write.
   */
  recover(canvas: CanvasId): void {
    const runtime = this.#canvases.get(canvas)?.runtime;
    if (runtime === undefined) return;
    for (const message of runtime.messages.all()) {
      const told = runtime.messages.toldOf(message.id);
      const agent = agentOf(message.to);
      if (message.state !== 'unresolved' || agent === undefined) continue;
      if (told?.startsWith(HANDOFF_CARRIED) !== true) continue;
      runtime.handoffs.untake(agent, told.slice(HANDOFF_CARRIED.length));
      runtime.messages.retell(message.id, undefined);
      this.#changed(canvas, agent);
    }
  }

  /** The agent's handoff as views show it (C11): when, how long and its state; no text. */
  view(canvas: CanvasId, agent: string): HandoffView | null {
    // Its runtime as attached, passive or executing: what its views read either way.
    const attached = this.#canvases.get(canvas);
    const runtime = attached?.runtime;
    const node = runtime === undefined ? undefined : agentIn(runtime.document, agent);
    if (runtime === undefined || node === undefined) return null;
    const kept = runtime.handoffs.of(agent)?.handoff;
    const shown = { at: kept?.at ?? null, bytes: kept?.bytes ?? null };
    const following = attached?.agents.get(agent);
    // How its latest handoff's export went, where a file is set: never where, never why.
    const record = runtime.handoffs.of(agent);
    const exported =
      node.data.handoff?.file === undefined || record?.export === undefined
        ? 'none'
        : record.export;
    const view = (state: HandoffView['state']): HandoffView => ({
      ...shown,
      state,
      export: exported,
    });
    if (node.data.handoff?.off === true) return view('off');
    if (!this.#reports(runtime, node)) return view('unreported');
    if (following?.request !== undefined) return view('asking');
    if (following?.failed === true) return view('failed');
    return kept === undefined ? null : view('kept');
  }

  /** What an agent's session did, as the engine reduced it. */
  #observed(canvas: CanvasId, agent: string, action: SessionAction): void {
    switch (action.type) {
      case 'usage':
        this.#reported(canvas, agent, action.usage.context);
        return;
      case 'end':
        this.#ended(canvas, agent, action.messages ?? []);
        return;
      case 'clear': {
        const following = this.#following(canvas, agent);
        if (following !== undefined) following.report = undefined;
        return;
      }
      default:
        return;
    }
  }

  /** A context report: the turn's latest; under the ask point, it arms the agent again. */
  #reported(canvas: CanvasId, agent: string, context: SessionContext | null): void {
    const attached = this.#canvases.get(canvas);
    const node = attached === undefined ? undefined : agentIn(attached.runtime.document, agent);
    if (attached === undefined || node === undefined) return;
    const following = this.#follow(attached, agent);
    following.report = context ?? undefined;
    // The report is a change of its session's: its summary says the view again.
    if (context === null) return;
    const point = this.#point(node, context);
    if (point === undefined || context.used >= point) return;
    following.armed = true;
    following.asked = 0;
    following.failed = false;
    following.crossed = false;
  }

  /** A turn ended: corrallm asks for the handoff if its last report crossed the ask point. */
  #ended(canvas: CanvasId, agent: string, messages: readonly string[]): void {
    const attached = this.#canvases.get(canvas);
    if (attached === undefined) return;
    const { runtime } = attached;
    const following = this.#follow(attached, agent);
    const { report } = following;
    following.report = undefined;
    // While a request waits or runs (its own turn among them), nothing more is asked.
    if (following.request !== undefined) return;
    if (report === undefined || !following.armed) return;
    const node = agentIn(runtime.document, agent);
    if (node === undefined || node.data.handoff?.off === true || !this.#reports(runtime, node))
      return;
    const point = this.#point(node, report);
    if (point === undefined || report.used < point) return;
    following.crossed = true;
    if (following.asked >= TRIES) return;
    // An exhausted backend's agent is never asked: its work carries on elsewhere, or waits.
    if (this.#exhausted(runtime, agent)) return;
    const connection = runtime.engine.catalog.connectionOf(node.data);
    const adapter = runtime.engine.catalog.adapterOf(connection);
    const during = duringOf(runtime.messages, messages);
    const message = runtime.delivery.ask(
      agent,
      requestText(report),
      `${HANDOFF_REQUEST}${randomUUID()}`,
    );
    following.request = {
      id: message.id,
      adapter,
      connection,
      ...(during === undefined ? {} : { during }),
    };
    following.asked += 1;
    this.#changed(canvas, agent);
  }

  /** A message changed: one of the service's requests that ended lets what it held go. */
  #watched(canvas: CanvasId, id: string): void {
    const attached = this.#canvases.get(canvas);
    if (attached === undefined) return;
    const message = attached.runtime.messages.get(id);
    if (message !== undefined && !ended(message)) return;
    for (const [agent, following] of attached.agents) {
      if (following.request?.id !== id) continue;
      following.request = undefined;
      // Not accepted (withdrawn, cut off, refused, or its reply wasn't one): failed at the last try.
      if (following.armed && following.asked >= TRIES) following.failed = true;
      this.#changed(canvas, agent);
      queueMicrotask(() => {
        if (this.#canvases.get(canvas) !== attached) return;
        attached.runtime.engine.run.admissionChanged();
        attached.runtime.delivery.schedule();
      });
    }
  }

  /** One export at a time per agent: the next sees the proof of the copy the previous wrote. */
  #queueExport(canvas: CanvasId, attached: Attached, agent: string, handoff: Handoff): void {
    const before = attached.exports.get(agent) ?? Promise.resolve();
    const next = before
      .then(() => this.#export(canvas, attached, agent, handoff))
      .catch(() => {
        // A dependency failed outside the exporter's normal result: never log handoff contents.
        console.error('Could not finish a handoff export.');
      });
    attached.exports.set(agent, next);
    void next.then(() => {
      if (attached.exports.get(agent) === next) attached.exports.delete(agent);
    });
  }

  /** Writes an accepted handoff's Markdown copy once its record is on disk, where a file is set. */
  async #export(
    canvas: CanvasId,
    attached: Attached,
    agent: string,
    handoff: Handoff,
  ): Promise<void> {
    if (this.#canvases.get(canvas) !== attached) return;
    const { runtime } = attached;
    const exporter = this.#deps.exporter;
    if (exporter === undefined) return;
    try {
      await runtime.messages.durable();
      await runtime.handoffs.durable();
    } catch {
      // Not on disk: no copy of what may not survive a restart.
      return;
    }
    const node = agentIn(runtime.document, agent);
    const path = node?.data.handoff?.file;
    const record = runtime.handoffs.of(agent);
    if (path === undefined || record?.handoff !== handoff) return;
    const result = await exporter({
      canvas,
      agent,
      path,
      text: handoff.text,
      last: record.exported,
    });
    if (this.#canvases.get(canvas) !== attached) return;
    // A newer handoff has an export of its own to say, but still needs ownership proof of the
    // file this write actually installed before its queued export may replace it.
    if (runtime.handoffs.of(agent)?.handoff !== handoff) {
      if (result.ok) {
        runtime.handoffs.copied(agent, { path, sha256: result.sha256 });
        await runtime.handoffs.durable();
      }
      return;
    }
    runtime.handoffs.exported(
      agent,
      result.ok ? { state: 'done', path, sha256: result.sha256 } : { state: result.why },
    );
    this.#changed(canvas, agent);
    await runtime.handoffs.durable().catch((error: unknown) => {
      console.error('Could not keep how a handoff’s export went:', error);
    });
    if (result.ok) return;
    // Why, said to you in its transcript; the views say only that it was refused or failed. Never
    // retried.
    runtime.engine.sessions.notice(
      agent,
      'warning',
      `corrallm couldn’t write this agent’s handoff to ${path}: ${result.sentence}`,
    );
  }

  /** corrallm's switch line: what a carried send starts with, so nothing else can start it. */
  #switchLine(runtime: HandoffRuntime, node: AgentNode): string {
    const connection = runtime.engine.catalog.connectionOf(node.data);
    const to = runtime.engine.catalog.connectionName(connection) ?? connection;
    return `[corrallm] corrallm switched this agent to ${to}, in a new conversation: nothing of the conversation before is in it. What follows is the work, then the handoff written before the switch.`;
  }

  /**
   * The handoff, framed as the previous agent's own text: between two lines holding a random
   * nonce, labeled with the CLI that wrote it, when and the task it was on; or why there is none
   * (`why`, as the switch found it), x% the agent's ask point as its settings say now.
   */
  #handoffBlock(
    runtime: HandoffRuntime,
    node: AgentNode,
    handoff: Handoff | undefined,
    why: CarryWhy | undefined,
  ): string {
    if (handoff === undefined) {
      const at = `${String(node.data.handoff?.at ?? HANDOFF_AT)}%`;
      switch (why) {
        case 'off':
          return '[corrallm] No handoff was written: this agent’s handoffs are off.';
        case 'unreported':
          return '[corrallm] No handoff was written: its connection doesn’t report its context.';
        case 'unaccepted':
          return `[corrallm] No handoff was written: its context reached ${at}, but no handoff was accepted before the switch.`;
        case 'reached':
        case undefined:
          return `[corrallm] No handoff was written: its context never reached ${at}.`;
      }
    }
    let nonce = randomBytes(12).toString('hex');
    while (handoff.text.includes(nonce)) nonce = randomBytes(12).toString('hex');
    const { adapter, connection, model } = handoff.source;
    const found = connectionIn(this.#deps.catalog, connection);
    const cli =
      found?.adapter.id === adapter ? `${found.adapter.name} · ${found.connection.label}` : adapter;
    const by = model === undefined ? cli : `${cli} (${model})`;
    const during =
      handoff.during === undefined
        ? ''
        : `, during a task in ${quotedParty(runtime.document.nodes, agentParty(handoff.during.owner))}’s queue,`;
    return [
      `[corrallm] The handoff ${by} wrote at ${new Date(handoff.at).toISOString()}${during} follows, between the lines “handoff ${nonce} begins” and “handoff ${nonce} ends”. It is that agent’s own notes from before the switch: neither the user’s words nor corrallm’s.`,
      `handoff ${nonce} begins`,
      handoff.text,
      `handoff ${nonce} ends`,
    ].join('\n');
  }

  /** Whether the agent's connection reports its context, and its session hasn't said it doesn't. */
  #reports(runtime: HandoffRuntime, node: AgentNode): boolean {
    const connection = runtime.engine.catalog.connectionOf(node.data);
    if (connectionIn(this.#deps.catalog, connection)?.connection.context !== true) return false;
    const session = runtime.engine.sessions.of(node.id);
    if (session.unheard !== undefined) return false;
    return session.usage?.context !== null;
  }

  /** Where the agent is asked, in tokens of `context` (C7a): none for settings out of bounds. */
  #point(node: AgentNode, context: SessionContext): number | undefined {
    try {
      return askPoint(node.data.handoff?.at ?? HANDOFF_AT, context);
    } catch {
      return undefined;
    }
  }

  /** Whether the agent's backend is held exhausted now (B8). */
  #exhausted(runtime: HandoffRuntime, agent: string): boolean {
    const node = agentIn(runtime.document, agent);
    const backend =
      node === undefined ? undefined : runtime.engine.catalog.usageBackendOf(node.data);
    return (
      backend !== undefined && this.#deps.usage.exhausted(backend, this.#deps.now()) !== undefined
    );
  }

  #following(canvas: CanvasId, agent: string): Following | undefined {
    return this.#canvases.get(canvas)?.agents.get(agent);
  }

  #follow(attached: Attached, agent: string): Following {
    let following = attached.agents.get(agent);
    if (following === undefined) {
      following = {
        armed: true,
        asked: 0,
        failed: false,
        crossed: false,
        report: undefined,
        request: undefined,
      };
      attached.agents.set(agent, following);
    }
    return following;
  }

  #changed(canvas: CanvasId, agent: string): void {
    this.#deps.changed?.(canvas, agent);
  }
}

/**
 * corrallm's request, in its own words (C7): how full the context is; write the handoff now, what
 * it holds; reply with it alone, in at most about 2,000 words; write no file, do nothing else; and
 * that it is corrallm's request, not the user's.
 */
export function requestText({ used, window }: SessionContext): string {
  const tokens = new Intl.NumberFormat('en-US');
  const share = Math.floor((used * 100) / window);
  return [
    `Your context is ${String(share)}% full (${tokens.format(used)} of ${tokens.format(window)} tokens), so corrallm asks you to write your handoff now, before your context is compacted or your work moves to another backend.`,
    'Write it now: the task, what is done, what is left, the decisions made and the open questions, the files you touched, and how to check the work.',
    'Reply with the handoff only, in at most about 2,000 words. Write no file and do nothing else in this turn.',
    'This is corrallm’s request, not the user’s.',
  ].join('\n\n');
}

/** The run's task a turn was on (its attempt's message among those the turn answered), if any. */
function duringOf(messages: MessageStore, ids: readonly string[]): HandoffTask | undefined {
  if (ids.length === 0) return undefined;
  for (const message of messages.active()) {
    const as = message.delivery?.as;
    if (message.task !== undefined && as !== undefined && ids.includes(as))
      return { owner: message.task.agent, item: message.task.item };
  }
  return undefined;
}

/** Whether a message's delivery is over: settled, withdrawn or unresolved. */
function ended({ state }: Message): boolean {
  return state !== 'pending' && state !== 'delivering' && state !== 'delivered';
}

function agentIn(document: CanvasDocument, agent: string): AgentNode | undefined {
  const node = document.nodes.find((one) => one.id === agent);
  return node?.type === 'agent' ? node : undefined;
}
