import { homedir } from 'node:os';

import type { z } from 'zod';

import { adapterIn, connectionIn, isStartMode } from '../../shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../../shared/adapter';
import { ConversationId } from '../../shared/api/ids';
import type { NeedId } from '../../shared/api/ids';
import type { CanvasId } from '../../shared/canvas';
import * as agentEdits from '../../shared/model/agent-ops';
import type { AgentNode } from '../../shared/model/canvas';
import { threadTitle } from '../../shared/model/session';
import { andList } from '../../shared/model/words';
import { MAX_MCP_ERROR_LENGTH, MAX_MCP_NAME_LENGTH, MAX_MCP_SERVERS } from '../../shared/session';
import type {
  AgentSettingsChange,
  FilesRewind,
  McpChange,
  McpServer,
  MessageImage,
  PastSession,
  RewindRestore,
  RewindResult,
  SessionMode,
  SettingsOptions,
} from '../../shared/session';
import { ConversationRefusal } from '../sessions/manager';
import type { SessionManager } from '../sessions/manager';
import { OpFailure, ProposedInstead } from './call';
import type { OpContext, RuleOutcome } from './call';
import { callerKey, partyIdOf } from './caller';
import type { TokenCaller } from './caller';
import type { Proposals } from './canvas/proposals';
import { DeliveryError } from './delivery/delivery';
import type { Engines, OpenCanvas } from './engines';
import { nameOf, partyText, quotedName } from './parties';
import { guardedFiles, RewindGuardSchema, sameGuard } from './rewind-guard';
import type { RewindGuard } from './rewind-guard';
import type { WorkspaceGate } from './workspaces/gate';
import { requireAgent } from './ops/agent-document';

/*
 * What B11 C6's session operations do (B11 Design §6, §7, §16), as the core's services: each a
 * single operation, however many effects it has, with its checks before its point of no return and
 * honest reports after it (§6: external effects are not SQL transactions).
 *
 * - Live and saved settings: a mode, model or effort changes the running session first, awaited
 *   (refused, changing nothing, if it can't), then the agent's saved setting (ctx.commit); a saved
 *   change that fails after the live one says what changed. A mode that never asks is live only
 *   and unsets the saved mode; a mode that asks but isn't one its connection starts in is live
 *   only; one its connection starts in is saved too.
 * - Continue in Terminal (§16.1): `agent.setConnection` through ctx.call (a pure doc op, as the
 *   caller), the new connection's session opened, then the optional input admitted once as your
 *   manual message through the mailbox, kept with its request: never dropped, never sent twice.
 * - Restart and new conversation: only an idle session with nothing waiting to go; a restart keeps
 *   its conversation reserved across the close (sessions/manager.ts `restarting`) and refuses to
 *   start over a close that didn't finish; a new conversation forgets only the chosen adapter's.
 * - Rewind: conversation only, at once; code (alone or with the conversation) under the workspace
 *   mutation gate, protecting every agent working in that tree, and, on a proposal's Allow, only if
 *   R5's guard reads the same again (else a conflict: settled stale).
 * - R5: a token's code rewind applies nothing: it comes to you as a proposal carrying its guard.
 */

/** How long a rewind proposal's words quote the message it goes back to. */
const QUOTED = 60;
/** The most files a proposal's detail names, then how many more. */
const NAMED_FILES = 5;

export interface SessionControlDeps {
  engines: Pick<Engines, 'canvas'>;
  sessions: Pick<
    SessionManager,
    | 'running'
    | 'binding'
    | 'setMode'
    | 'setModel'
    | 'setEffort'
    | 'stopTask'
    | 'restarting'
    | 'previewRewind'
    | 'conversationOf'
    | 'availability'
    | 'listSessions'
    | 'listedTo'
    | 'resumeSession'
    | 'settingsOptions'
    | 'mcpServers'
    | 'changeMcpServer'
  >;
  gate: Pick<WorkspaceGate, 'mutate'>;
  proposals: Pick<Proposals, 'raise'>;
  /** What every adapter declares. */
  catalog: Catalog;
  /** The adapter agents run when none is chosen. */
  defaultAdapter: AdapterId;
  /** The home folder a preview's `~` paths are in. */
  home?: () => string;
}

/** An agent of an open canvas, as these services read it. */
interface Target {
  open: OpenCanvas;
  node: AgentNode;
  adapter: AdapterId;
  connection: ConnectionId;
  /** As a sentence names it. */
  name: string;
}

export class SessionControl {
  readonly #deps: SessionControlDeps;

  constructor(deps: SessionControlDeps) {
    this.#deps = deps;
  }

  /** session.open: the agent's session started, if it isn't, with its settings now. */
  async open({ canvas, agent }: { canvas?: string | undefined; agent: string }): Promise<object> {
    const target = this.#target(canvas, agent);
    await this.#opened(target);
    return {};
  }

  /**
   * session.continueIn (§16.1, yours alone): the agent switched to `connection` (agent.setConnection
   * through ctx.call: a pure doc op, as you), its session there opened, then `then`, if given,
   * admitted once as your manual message through the mailbox (a shell command sent alone, as any
   * is). Kept with its request, so a repeat of it never sends it twice; a refused start leaves it
   * one durable pending message, its refusal said in the session, never a success notice.
   */
  async continueIn(
    {
      canvas,
      agent,
      connection,
      then,
      request,
    }: {
      canvas?: string | undefined;
      agent: string;
      connection: string;
      then?: { text: string; images?: MessageImage[] | undefined } | undefined;
      request?: string | undefined;
    },
    ctx: OpContext,
  ): Promise<{ id?: string }> {
    const open = this.#openCanvas(canvas);
    this.#agentOf(open, agent);
    // The switch lands first: what follows goes to the session it opens.
    await ctx.call('agent.setConnection', { canvas: open.document.id, agent, connection });
    let refusal: string | undefined;
    try {
      await this.#opened(this.#target(canvas, agent));
    } catch (error) {
      refusal = reasonOf(error);
    }
    if (then === undefined) {
      if (refusal !== undefined) throw new OpFailure('unavailable', refusal);
      return {};
    }
    const told = request === undefined ? undefined : `continued:${request}`;
    const admitted = told === undefined ? undefined : open.messages.toldAs(told);
    if (admitted !== undefined) return { id: admitted.id };
    ctx.noReturn();
    try {
      const sent = await open.delivery.send(partyIdOf(ctx.caller), agent, then.text, undefined, {
        ...(then.images === undefined ? {} : { images: then.images }),
        ...(told === undefined ? {} : { told }),
      });
      return { id: sent.id };
    } catch (error) {
      if (error instanceof DeliveryError) throw new OpFailure(error.code, error.message);
      throw error;
    }
  }

  /** session.setMode: live, then saved where its connection starts in it (yours alone, D9). */
  async setMode(
    { canvas, agent, mode }: { canvas?: string | undefined; agent: string; mode: string },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    const { open, adapter, connection, name } = target;
    const descriptor = adapterIn(this.#deps.catalog, adapter);
    const known = descriptor?.modes.find((one) => one.id === mode);
    if (known === undefined) {
      throw new OpFailure('invalid', `${mode} isn’t a mode of ${descriptor?.name ?? adapter}.`);
    }
    const reported = open.engine.sessions.of(agent).modes;
    if (reported !== undefined && !reported.includes(mode as SessionMode)) {
      throw new OpFailure(
        'refused',
        `${name}’s CLI has ${known.label} turned off in its settings.`,
      );
    }
    // Saved only where its connection starts in it; one that never asks unsets the saved one.
    const saved: AgentSettingsChange | undefined = !known.asks
      ? { mode: null }
      : isStartMode(this.#deps.catalog, adapter, connection, mode)
        ? { mode }
        : undefined;
    const running = this.#deps.sessions.running(target.open.document.id, agent);
    if (!running && saved?.mode !== mode) {
      throw new OpFailure(
        'refused',
        `${known.label} is chosen in ${name}’s running session, not saved for its start: open its session first.`,
      );
    }
    await this.#liveAndSaved(ctx, target, {
      what: `run in ${known.label}`,
      ...(running
        ? {
            live: async () => {
              await this.#deps.sessions.setMode(open.document.id, agent, mode as SessionMode);
              open.engine.sessions.applied(agent, { mode: mode as SessionMode });
            },
          }
        : {}),
      ...(saved === undefined ? {} : { saved }),
    });
    return {};
  }

  /** session.setModel: live, then saved. */
  async setModel(
    { canvas, agent, model }: { canvas?: string | undefined; agent: string; model: string },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    const { open, name } = target;
    const offered = open.engine.sessions.of(agent).models ?? [];
    if (offered.length > 0 && !offered.some((one) => one.value === model)) {
      throw new OpFailure('invalid', `${model} isn’t one of the models ${name}’s session offers.`);
    }
    const running = this.#deps.sessions.running(open.document.id, agent);
    await this.#liveAndSaved(ctx, target, {
      what: `use ${model}`,
      ...(running
        ? {
            live: async () => {
              await this.#deps.sessions.setModel(open.document.id, agent, model);
              open.engine.sessions.applied(agent, { model });
            },
          }
        : {}),
      saved: { model },
    });
    return {};
  }

  /** session.setEffort: live where its connection takes it from corrallm, then saved (null: the model's default). */
  async setEffort(
    {
      canvas,
      agent,
      effort,
    }: { canvas?: string | undefined; agent: string; effort: string | null },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    const { open, connection, name } = target;
    const session = open.engine.sessions.of(agent);
    const running = this.#deps.sessions.running(open.document.id, agent);
    if (running && connectionIn(this.#deps.catalog, connection)?.connection.live.effort !== true) {
      throw new OpFailure('refused', `${name}’s effort is set in its terminal while it runs.`);
    }
    const efforts = session.models?.find((one) => one.value === session.model)?.efforts;
    if (effort !== null && efforts !== undefined && !efforts.some((one) => one.value === effort)) {
      throw new OpFailure('invalid', `${name}’s model offers no ${effort} effort.`);
    }
    await this.#liveAndSaved(ctx, target, {
      what: effort === null ? 'reason at its model’s default effort' : `reason at ${effort} effort`,
      ...(running
        ? {
            live: async () => {
              await this.#deps.sessions.setEffort(open.document.id, agent, effort);
              open.engine.sessions.applied(agent, { effort });
            },
          }
        : {}),
      saved: { effort },
    });
    return {};
  }

  /** session.stopTask: a background task its session reports now, on a connection that stops one. */
  async stopTask(
    { canvas, agent, task }: { canvas?: string | undefined; agent: string; task: string },
    ctx: OpContext,
  ): Promise<object> {
    const { open, connection, name } = this.#target(canvas, agent);
    if (connectionIn(this.#deps.catalog, connection)?.connection.live.stopTask !== true) {
      throw new OpFailure('refused', `${name}’s background tasks are stopped in its terminal.`);
    }
    if (!(open.engine.sessions.of(agent).tasks ?? []).some((one) => one.id === task)) {
      throw new OpFailure('not-found', `${name}’s session runs no task ${task} now.`);
    }
    ctx.noReturn();
    await this.#effect(() => this.#deps.sessions.stopTask(open.document.id, agent, task));
    return {};
  }

  /**
   * session.restart: an idle session with nothing waiting to go closes and starts again with its
   * settings now, on the same conversation (reserved for it meanwhile): never over a close that
   * didn't finish.
   */
  async restart(
    { canvas, agent }: { canvas?: string | undefined; agent: string },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    const { open, adapter } = target;
    await this.#launchable(target, 'restart');
    // Idle as it closes: nothing awaited between this check and its effect.
    this.#idle(target, 'restart it');
    ctx.noReturn();
    await this.#effect(() => this.#deps.sessions.restarting(open.document.id, agent, adapter));
    await open.engine.sessions.restart(agent);
    await this.#opened(target, 'It closed, but couldn’t start again');
    return {};
  }

  /**
   * session.newConversation: an idle session with nothing waiting to go closes, only the chosen
   * adapter's conversation is forgotten (its native history stays), and it starts again, once.
   */
  async newConversation(
    { canvas, agent }: { canvas?: string | undefined; agent: string },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    await this.#launchable(target, 'start a new conversation');
    // Idle as it closes: nothing awaited between this check and its effect.
    this.#idle(target, 'start a new conversation');
    ctx.noReturn();
    await this.#effect(() => target.open.engine.sessions.fresh(agent));
    await this.#opened(target, 'Its conversation was forgotten, but it couldn’t start again');
    return {};
  }

  /**
   * session.conversations (B11 Design §7): its adapter's conversations in its workspace now, most
   * recent first, which one is its own; listed to this caller alone (its window, session or token,
   * never its party), and only those it may then resume, in that binding, for a while.
   */
  async conversations(
    { canvas, agent }: { canvas?: string | undefined; agent: string },
    ctx: OpContext,
  ): Promise<{ items: (PastSession & { id: z.infer<typeof ConversationId> })[] }> {
    const { open, adapter } = this.#target(canvas, agent);
    const descriptor = adapterIn(this.#deps.catalog, adapter);
    if (descriptor?.list !== true) {
      throw new OpFailure(
        'refused',
        `${descriptor?.name ?? adapter} keeps no conversations corrallm can list.`,
      );
    }
    const listed = await this.#effect(() =>
      this.#deps.sessions.listSessions(open.document.id, agent, callerKey(ctx.caller)),
    );
    // R42 at this boundary too: an id that isn't the platform's shape is never shown.
    return {
      items: listed.flatMap((one) => {
        const id = ConversationId.safeParse(one.id);
        return id.success ? [{ ...one, id: id.data }] : [];
      }),
    };
  }

  /**
   * session.resumeConversation (B11 Design §7): an idle session with nothing waiting to go closes
   * and starts again on a conversation listed to this caller, in the binding it was listed in, that
   * no other agent's session holds (refused before anything closes), reserved for it meanwhile.
   */
  async resumeConversation(
    {
      canvas,
      agent,
      conversation,
    }: { canvas?: string | undefined; agent: string; conversation: string },
    ctx: OpContext,
  ): Promise<object> {
    const target = this.#target(canvas, agent);
    const { open, name } = target;
    const caller = callerKey(ctx.caller);
    if (!this.#deps.sessions.listedTo(open.document.id, agent, caller, conversation)) {
      throw new OpFailure(
        'not-found',
        `That isn’t one of ${name}’s conversations listed to you: list them again.`,
      );
    }
    await this.#launchable(target, 'resume a conversation');
    // Idle as it closes: nothing awaited between this check and its effect.
    this.#idle(target, 'resume a conversation');
    ctx.noReturn();
    try {
      await this.#deps.sessions.resumeSession(open.document.id, agent, conversation, caller);
    } catch (error) {
      if (error instanceof ConversationRefusal) throw new OpFailure(error.code, error.message);
      throw new OpFailure('unavailable', reasonOf(error));
    }
    open.engine.sessions.resumed(agent);
    await this.#opened(target, 'It took that conversation, but couldn’t start again');
    return {};
  }

  /**
   * session.options: what an agent of `adapter` can be set to run with, and the user's own
   * defaults, read in that agent's workspace now (its binding checked again), or the canvas's
   * project folder without one: never a cached canvas-wide answer.
   */
  async options({
    canvas,
    agent,
    adapter,
  }: {
    canvas?: string | undefined;
    agent?: string | undefined;
    adapter: string;
  }): Promise<SettingsOptions> {
    const open = this.#openCanvas(canvas);
    if (adapterIn(this.#deps.catalog, adapter) === undefined) {
      throw new OpFailure('invalid', `corrallm has no adapter ${adapter}.`);
    }
    if (agent !== undefined) this.#agentOf(open, agent);
    return this.#effect(() =>
      this.#deps.sessions.settingsOptions(open.document.id, adapter, agent),
    );
  }

  /**
   * session.viewCommand (yours alone, a view's): a command its agent view answered itself in a
   * panel (one its connection's catalog `panels` names) kept as your message, settled at once and
   * never sent to its CLI. What the panel then shows it reads, or does, by operations of its own.
   */
  async viewCommand({
    canvas,
    agent,
    text,
  }: {
    canvas?: string | undefined;
    agent: string;
    text: string;
  }): Promise<{ id: string }> {
    const { open, connection, name } = this.#target(canvas, agent);
    const command = /^\s*\/([^\s/]+)(?:\s[\s\S]*)?$/.exec(text)?.[1];
    const panels = connectionIn(this.#deps.catalog, connection)?.connection.panels ?? {};
    if (command === undefined || !Object.hasOwn(panels, command)) {
      throw new OpFailure(
        'invalid',
        `${name}’s view answers no ${command === undefined ? 'such command' : `/${command}`} itself.`,
      );
    }
    try {
      return { id: (await open.delivery.record(agent, text)).id };
    } catch (error) {
      throw new OpFailure('unavailable', reasonOf(error));
    }
  }

  /** session.mcpServers (/mcp): the servers its running session reports now, bounded. */
  async mcpServers({
    canvas,
    agent,
  }: {
    canvas?: string | undefined;
    agent: string;
  }): Promise<{ items: McpServer[] }> {
    const target = this.#target(canvas, agent);
    this.#mcpPanel(target);
    return { items: await this.#servers(target) };
  }

  /**
   * session.changeMcpServer (/mcp): reconnects, enables or disables one server its session reports
   * now (never a command, a URL or a server it doesn't), on a connection that offers that change;
   * says so in its transcript, and answers with its servers as they are then, so /mcp shows them
   * without a second operation.
   */
  async changeMcpServer(
    {
      canvas,
      agent,
      server,
      change,
    }: { canvas?: string | undefined; agent: string; server: string; change: McpChange },
    ctx: OpContext,
  ): Promise<{ items: McpServer[] }> {
    const target = this.#target(canvas, agent);
    const { open, name } = target;
    if (!this.#mcpPanel(target).changes.includes(change)) {
      throw new OpFailure('refused', `${name}’s MCP servers can’t be ${MCP_DONE[change]} here.`);
    }
    if (!(await this.#servers(target)).some((one) => one.name === server)) {
      throw new OpFailure(
        'not-found',
        `${name}’s session has no MCP server ${quotedName(server)}.`,
      );
    }
    ctx.noReturn();
    const items = bounded(
      await this.#effect(() =>
        this.#deps.sessions.changeMcpServer(open.document.id, agent, server, change),
      ),
    );
    const by = partyIdOf(ctx.caller);
    const what = `${MCP_DONE[change]} the MCP server ${quotedName(server)}.`;
    open.engine.sessions.notice(
      agent,
      'info',
      by === 'you'
        ? `${what.charAt(0).toUpperCase()}${what.slice(1)}`
        : `${partyText(open.document.nodes, by)} ${what}`,
    );
    return { items };
  }

  /** session.rewindPreview: what restoring its files to before `message` would change. */
  async rewindPreview({
    canvas,
    agent,
    message,
  }: {
    canvas?: string | undefined;
    agent: string;
    message: string;
  }): Promise<FilesRewind> {
    const { open } = this.#target(canvas, agent);
    return this.#effect(() => this.#deps.sessions.previewRewind(open.document.id, agent, message));
  }

  /**
   * session.rewind: its conversation, its files or both, to before `message`. Its files only under
   * the workspace mutation gate, every agent working there idle; on a proposal's Allow (ctx.guard),
   * only if what it would restore reads the same as it was proposed (else a conflict).
   */
  async rewind(
    {
      canvas,
      agent,
      message,
      restore,
    }: { canvas?: string | undefined; agent: string; message: string; restore: RewindRestore },
    ctx: OpContext,
  ): Promise<RewindResult> {
    const target = this.#target(canvas, agent);
    const { open, name } = target;
    // A conversation rewind ends its session, to resume the copy: only where it can start again.
    if (restore !== 'code') await this.#launchable(target, 'rewind its conversation');
    // Idle as it rewinds: nothing awaited between this check and a conversation's rewind (a code
    // restore's gate checks every agent of its tree again, itself too).
    if (open.engine.sessions.of(agent).status !== 'idle') {
      throw new OpFailure('refused', `${name} has a turn going on: rewind it once it is idle.`);
    }
    const apply = () => {
      ctx.noReturn();
      return this.#effect(() => open.engine.sessions.rewind(agent, message, restore));
    };
    if (restore === 'conversation') return apply();
    return this.#deps.gate.mutate(open.document.id, agent, async () => {
      if (ctx.guard !== undefined) {
        const proposed = RewindGuardSchema.parse(ctx.guard);
        const now = await this.#guard(target, message).catch((error: unknown) => {
          throw new OpFailure('conflict', `it can’t be previewed now (${reasonOf(error)})`);
        });
        if (!sameGuard(proposed, now)) {
          throw new OpFailure(
            'conflict',
            'What it would restore changed since it was proposed: its files, its session or its preview.',
          );
        }
      }
      return apply();
    });
  }

  /**
   * R5 on a token's session.rewind: a code restore (alone or with the conversation) applies
   * nothing, and comes to you as a proposal carrying its guard; refused, saying why, if it can't be
   * previewed or would change more files than a proposal guards.
   */
  async restoreCode(
    args: {
      canvas?: string | undefined;
      agent: string;
      message: string;
      restore: RewindRestore;
    },
    { caller }: { caller: TokenCaller },
  ): Promise<RuleOutcome> {
    if (args.restore === 'conversation') return undefined;
    const target = this.#target(args.canvas, args.agent);
    let guard: RewindGuard;
    try {
      guard = await this.#guard(target, args.message);
    } catch (error) {
      return { refuse: reasonOf(error) };
    }
    const { open, name } = target;
    const { nodes } = open.document;
    const by = partyIdOf(caller);
    const entry = open.engine.sessions
      .of(args.agent)
      .entries.find((one) => one.id === args.message);
    const before = `before “${entry?.kind === 'user' ? threadTitle(entry.text, QUOTED) : 'that message'}”`;
    const count = guard.files.length;
    const files = `${String(count)} file${count === 1 ? '' : 's'}`;
    const what = `restore ${name}’s files to how they were ${before}${args.restore === 'both' ? ', and rewind its conversation' : ''}`;
    const named = guard.files.slice(0, NAMED_FILES).map(({ path }) => path);
    const more = count - named.length;
    const id: NeedId = await this.#deps.proposals.raise(open.document.id, {
      op: 'session.rewind',
      args: {
        canvas: open.document.id,
        agent: args.agent,
        message: args.message,
        restore: args.restore,
      },
      by,
      touched: {},
      lost: {
        what,
        title: `${partyText(nodes, by)} asks to ${what}: ${files}`,
        ...(count === 0
          ? {}
          : {
              detail: `It changes ${andList([...named, ...(more > 0 ? [`${String(more)} more`] : [])])} for every agent working in that folder. Allow applies it only if none of it changed since.`,
            }),
        agents: [args.agent],
        agent: args.agent,
      },
      guard,
    });
    return { propose: id };
  }

  /** Its connection's /mcp panel, as the catalog declares it: refused where it has none. */
  #mcpPanel({ connection, name }: Target): { changes: readonly McpChange[] } {
    const panel = connectionIn(this.#deps.catalog, connection)?.connection.panels.mcp;
    if (panel === undefined) {
      throw new OpFailure('refused', `${name}’s MCP servers are managed in its terminal (/mcp).`);
    }
    return panel;
  }

  /** The MCP servers its running session reports now, as /mcp shows them: bounded. */
  async #servers({ open, node }: Target): Promise<McpServer[]> {
    return bounded(
      await this.#effect(() => this.#deps.sessions.mcpServers(open.document.id, node.id)),
    );
  }

  /** The open canvas `canvas` names: unavailable if it isn't open (the core doesn't run it). */
  #openCanvas(canvas: string | undefined): OpenCanvas {
    if (canvas === undefined) throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
    const open = this.#deps.engines.canvas(canvas as CanvasId);
    if (open === undefined)
      throw new OpFailure('unavailable', 'That canvas isn’t open in corrallm.');
    return open;
  }

  /** Agent `agent` of an open canvas: not-found if there is none. */
  #agentOf(open: OpenCanvas, agent: string): AgentNode {
    const node = open.document.nodes.find((one) => one.id === agent);
    if (node?.type !== 'agent') throw new OpFailure('not-found', `There is no agent ${agent}.`);
    return node;
  }

  /** The agent `agent` of the open canvas `canvas`, with how it runs: not-found, unavailable. */
  #target(canvas: string | undefined, agent: string): Target {
    const open = this.#openCanvas(canvas);
    const node = this.#agentOf(open, agent);
    const adapter = node.data.adapter ?? this.#deps.defaultAdapter;
    const connection = open.engine.catalog.connectionOf(node.data);
    const name = nameOf(open.document.nodes, agent);
    if (connection === 'unavailable') {
      throw new OpFailure('unavailable', `${name} runs on a connection this corrallm lacks.`);
    }
    return { open, node, adapter, connection, name };
  }

  /** Refuses, before anything, a session that isn't idle or has messages waiting to go. */
  #idle({ open, node, name }: Target, what: string): void {
    const session = open.engine.sessions.of(node.id);
    if (session.status !== 'idle') {
      throw new OpFailure('refused', `${name} has a turn going on: ${what} once it is idle.`);
    }
    if (session.queued.length > 0 || open.delivery.current(node.id) !== undefined) {
      throw new OpFailure(
        'refused',
        `${name} has messages waiting to go: ${what} once they have gone.`,
      );
    }
  }

  /**
   * Refuses, before anything, what would end a session its next launch couldn't replace: its
   * working directory held (a rebind waiting for you, a setup, another agent's restore). One whose
   * binding is merely stale (an approved switch installed another) may: its next launch is in the
   * new one.
   */
  async #launchable({ open, node, name }: Target, what: string): Promise<void> {
    const availability = await this.#deps.sessions.availability(open.document.id, node.id);
    if (!availability.ready && availability.reason !== 'stale') {
      throw new OpFailure('unavailable', `${name} can’t ${what} now: ${availability.sentence}`);
    }
  }

  /** Its session running, started with its settings now if it wasn't: unavailable, saying why. */
  async #opened({ open, node }: Target, before?: string): Promise<void> {
    try {
      await open.engine.sessions.ready(node.id);
    } catch (error) {
      throw new OpFailure(
        'unavailable',
        before === undefined ? reasonOf(error) : `${before}: ${reasonOf(error)}`,
      );
    }
  }

  /**
   * A live change, awaited, then the saved one, past the point of no return: the live change
   * refused changes nothing; the saved one failing after it says what changed.
   */
  async #liveAndSaved(
    ctx: OpContext,
    { open, node, adapter, name }: Target,
    change: { what: string; live?: () => Promise<void>; saved?: AgentSettingsChange },
  ): Promise<void> {
    ctx.noReturn();
    if (change.live) {
      try {
        await change.live();
      } catch (error) {
        throw new OpFailure(
          'unavailable',
          `${name}’s session couldn’t ${change.what}, so nothing changed: ${reasonOf(error)}`,
        );
      }
    }
    if (change.saved === undefined) return;
    const saved = change.saved;
    try {
      await ctx.commit(open.document.id, (document) => {
        requireAgent(document, node.id);
        return agentEdits.setSettings(document, { agent: node.id, adapter, change: saved });
      });
    } catch (error) {
      if (change.live === undefined || error instanceof ProposedInstead) throw error;
      // The live change stands: never rolled back by a write that failed.
      throw new OpFailure(
        'unavailable',
        `${name}’s session was changed to ${change.what}, but that couldn’t be saved for its next start: ${reasonOf(error)}`,
      );
    }
  }

  /** A session's effect, its failure an OpFailure saying why. */
  async #effect<T>(effect: () => Promise<T>): Promise<T> {
    try {
      return await effect();
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      throw new OpFailure('unavailable', reasonOf(error));
    }
  }

  /** What restoring the agent's files to before `message` is of, now (R5's guard). */
  async #guard({ open, node, adapter, connection }: Target, message: string): Promise<RewindGuard> {
    const canvas = open.document.id;
    const preview = await this.#deps.sessions.previewRewind(canvas, node.id, message);
    if (!preview.possible) throw new Error(preview.error ?? 'Its files can’t be restored to then.');
    const binding = this.#deps.sessions.binding(canvas, node.id);
    if (binding === undefined) throw new Error('This agent’s session is not running.');
    const files = await guardedFiles(binding.cwd, this.#deps.home?.() ?? homedir(), preview.files);
    return {
      adapter,
      conversation: (await this.#deps.sessions.conversationOf(canvas, node.id, adapter)) ?? null,
      message,
      connection,
      workspaceGeneration: binding.generation,
      files,
    };
  }
}

/** What an MCP change did, as a notice says it. */
const MCP_DONE: Readonly<Record<McpChange, string>> = {
  reconnect: 'reconnected',
  enable: 'enabled',
  disable: 'disabled',
};

/**
 * Servers as /mcp shows them, whatever a session reported: the first MAX_MCP_SERVERS of those a
 * change can name (a longer name is left out), each text cut to its bound.
 */
function bounded(servers: readonly McpServer[]): McpServer[] {
  const cut = (text: string, most: number) =>
    text.length > most ? `${text.slice(0, most - 1)}…` : text;
  return servers
    .filter(({ name }) => name.length > 0 && name.length <= MAX_MCP_NAME_LENGTH)
    .slice(0, MAX_MCP_SERVERS)
    .map(({ name, status, scope, server, tools, error }) => ({
      name,
      status,
      ...(scope === undefined ? {} : { scope: cut(scope, MAX_MCP_NAME_LENGTH) }),
      ...(server === undefined ? {} : { server: cut(server, MAX_MCP_NAME_LENGTH) }),
      ...(tools === undefined ? {} : { tools }),
      ...(error === undefined ? {} : { error: cut(error, MAX_MCP_ERROR_LENGTH) }),
    }));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
