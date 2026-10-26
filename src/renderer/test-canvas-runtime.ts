import type { UsageState } from '../shared/usage';
import type { UserMessage } from '../shared/session';
import type { CanvasDocument } from '../shared/model/canvas';
import type { SessionBackend } from '../shared/engine/transcript/receive';
import { NO_BACKEND } from '../shared/engine/transcript/receive';
import { Engine } from '../shared/engine/engine';
import { needs, needsOf, needsItem } from '../shared/engine/needs';
import { AgentId, MessageId } from '../shared/api/ids';
import * as AgentOps from '../shared/model/agent-ops';
import { catalog } from './catalog';
import { isStartMode } from '../shared/adapter';
import { isSessionMode } from '../shared/session';
import { OPS } from '../shared/api/registry';
import type { MessageView } from '../shared/model/views';
import { runView, sessionView } from '../shared/model/views';
import { runCatalog } from './graph/agents';
import type { fakeCore } from './test-api';

/** Execution lives on the fixture's core side, never inside GraphEditor. */
export function canvasRuntime(
  core: ReturnType<typeof fakeCore>,
  document: CanvasDocument,
  backend: SessionBackend = NO_BACKEND,
  commit: (next: CanvasDocument) => void = () => undefined,
  usage?: () => UsageState,
) {
  const engine = new Engine({
    catalog: runCatalog(),
    backend,
    ...(usage ? { usage } : {}),
    now: () => Date.now(),
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    connect: (agent, connection) => {
      commit(
        AgentOps.setConnection(
          { ...document, nodes },
          { agent, connection },
          { catalog: catalog(), defaultAdapter: engine.catalog.defaultAdapter },
        ).next,
      );
      engine.sessions.open(agent);
    },
  });
  const messageIds = new Map<string, string>();
  const messageId = (native: string) => {
    if (MessageId.safeParse(native).success) return native;
    let kept = messageIds.get(native);
    if (!kept) {
      kept = crypto.randomUUID();
      messageIds.set(native, kept);
    }
    return kept;
  };
  let nodes = document.nodes;
  const canvas = document.id;
  const publish = () => {
    const run = runView(engine.run.snapshot());
    const sessions = engine.sessions.snapshot();
    const views = Object.fromEntries(
      nodes
        .filter((node) => node.type === 'agent')
        .map((node) => {
          const id = node.id,
            session = engine.sessions.of(id);
          return [
            id,
            sessionView(
              AgentId.parse(id),
              engine.catalog.connectionOf(
                nodes.filter((node) => node.type === 'agent').find((node) => node.id === id)
                  ?.data ?? {},
              ),
              session,
            ),
          ];
        }),
    );
    const input = { canvas, nodes, run: engine.run.snapshot(), sessions, catalog: engine.catalog };
    const items = needs(input);
    const messages: MessageView[] = Object.entries(sessions).flatMap(([agent, session]) => [
      ...(session.submissions ?? []).map((message): MessageView => ({
        id: messageId(message.id),
        delivery: { as: message.id, at: 1, attempt: 1 },
        canvas,
        from: 'you',
        to: `agent:${agent}`,
        kind: 'text',
        body: message.text,
        at: 1,
        origin: 'manual',
        state:
          message.status === 'queued'
            ? 'pending'
            : message.status === 'running'
              ? 'delivered'
              : 'replied',
        ...(message.result ? { turn: message.result } : {}),
        ...(message.after ? { display: { after: message.after } } : {}),
      })),
      ...session.queued
        .filter((queued) => !session.submissions?.some((one) => one.id === queued.id))
        .map((queued): MessageView => ({
          id: messageId(queued.id),
          canvas,
          from: 'you',
          to: `agent:${agent}`,
          kind: 'text',
          body: queued.text,
          at: 1,
          origin: 'run',
          state: 'pending',
        })),
    ]);
    const oldRun = core.state(`run:${canvas}`);
    const oldSessions = core.state(`sessions:${canvas}`);
    const oldMessages = core.state(`messages:${canvas}`);
    const agents = Object.fromEntries(
      Object.entries(views).map(([id, view]) => [id, view.summary]),
    );
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    if (!oldRun) core.snapshot(`run:${canvas}`, run);
    else
      core.change({
        topic: `run:${canvas}`,
        rev: oldRun.rev + 1,
        top: { running: run.running, paused: run.paused ?? null, notices: [...run.notices] },
        agents: {
          set: run.agents,
          remove: Object.keys(oldRun.state.agents)
            .filter((id) => !Object.hasOwn(run.agents, id))
            .map((id) => AgentId.parse(id)),
        },
        groups: {
          set: run.groups,
          remove: Object.keys(oldRun.state.groups)
            .filter((id) => !Object.hasOwn(run.groups, id))
            .map((id) => AgentId.parse(id)),
        },
      });
    if (!oldSessions) core.snapshot(`sessions:${canvas}`, { agents });
    else
      core.change({
        topic: `sessions:${canvas}`,
        rev: oldSessions.rev + 1,
        agents: {
          set: agents,
          remove: Object.keys(oldSessions.state.agents)
            .filter((id) => !Object.hasOwn(agents, id))
            .map((id) => AgentId.parse(id)),
        },
      });
    if (!oldMessages)
      core.snapshot(`messages:${canvas}`, {
        items: messagesById,
        order: messages.map(({ id }) => MessageId.parse(id)),
        next: '',
      });
    else
      core.change({
        topic: `messages:${canvas}`,
        rev: oldMessages.rev + 1,
        set: messagesById,
        remove: Object.keys(oldMessages.state.items)
          .filter((id) => !Object.hasOwn(messagesById, id))
          .map((id) => MessageId.parse(id)),
        order: messages.map(({ id }) => MessageId.parse(id)),
        next: '',
      });
    for (const [id, view] of Object.entries(views)) {
      const topic = `session:${canvas}:${encodeURIComponent(id)}` as const;
      const old = core.state(topic);
      if (!old) core.snapshot(topic, view);
      else
        core.change({
          topic,
          rev: old.rev + 1,
          summary: view.summary,
          entries: { upsert: Object.values(view.entries), order: view.order },
        });
    }
    core.change({
      topic: `needs:${canvas}`,
      rev: (core.state(`needs:${canvas}`)?.rev ?? 0) + 1,
      replace: { items },
    });
  };
  const stops = [engine.run.subscribe(publish), engine.sessions.subscribe(publish)];
  engine.update(nodes);
  publish();
  const result = (value: object = {}) =>
    Promise.resolve({ ok: true as const, value: { ...value, revs: {} } });
  const read = (value: object) => Promise.resolve({ ok: true as const, value });
  function register() {
    core.reply('run.start', () => {
      engine.run.start();
      return result();
    });
    core.reply('run.stop', () => {
      engine.run.stop();
      return result();
    });
    core.reply('run.resume', () => {
      engine.run.resume();
      return result();
    });
    core.reply('run.goOn', (raw) => {
      const { agent, item } = OPS['run.goOn'].input.parse(raw);
      engine.run.goOn(agent, item);
      return result();
    });
    for (const op of ['run.pause', 'run.kill', 'run.unpause'] as const)
      core.reply(op, (raw) => {
        const { target } = OPS[op].input.parse(raw);
        const method = op === 'run.pause' ? 'pause' : op === 'run.kill' ? 'kill' : 'resume';
        if ('agent' in target) engine.run[`${method}Agent`](target.agent);
        else engine.run[`${method}Group`](target.group);
        return result(op === 'run.unpause' ? { held: [] } : {});
      });
    core.reply('session.open', async (raw) => {
      const { agent } = OPS['session.open'].input.parse(raw);
      engine.sessions.open(agent);
      return result();
    });
    for (const op of ['session.setMode', 'session.setModel', 'session.setEffort'] as const)
      core.reply(op, async (raw) => {
        const args = OPS[op].input.parse(raw);
        if ('mode' in args && isSessionMode(args.mode))
          engine.sessions.setMode(args.agent, args.mode);
        if ('model' in args) engine.sessions.setModel(args.agent, args.model);
        if ('effort' in args) engine.sessions.setEffort(args.agent, args.effort);
        const node = nodes.find((node) => node.type === 'agent' && node.id === args.agent);
        const data = node?.type === 'agent' ? node.data : {};
        const connection = engine.catalog.connectionOf(data);
        const adapter = engine.catalog.adapterOf(connection);
        const change =
          'mode' in args
            ? {
                mode:
                  isSessionMode(args.mode) && isStartMode(catalog(), adapter, connection, args.mode)
                    ? args.mode
                    : null,
              }
            : 'model' in args
              ? { model: args.model }
              : { effort: args.effort };
        commit(
          AgentOps.setSettings({ ...document, nodes }, { agent: args.agent, adapter, change }).next,
        );
        return result();
      });
    core.reply('session.restart', async (raw) => {
      await engine.sessions.restart(OPS['session.restart'].input.parse(raw).agent);
      return result();
    });
    core.reply('session.newConversation', async (raw) => {
      await engine.sessions.fresh(OPS['session.newConversation'].input.parse(raw).agent);
      return result();
    });
    core.reply('session.stopTask', async (raw) => {
      const { agent, task } = OPS['session.stopTask'].input.parse(raw);
      engine.sessions.stopTask(agent, task);
      return result();
    });
    core.reply('session.rewindPreview', async (raw) => {
      const { agent, message } = OPS['session.rewindPreview'].input.parse(raw);
      return result(await engine.sessions.previewRewind(agent, message));
    });
    core.reply('session.rewind', async (raw) => {
      const { agent, message, restore } = OPS['session.rewind'].input.parse(raw);
      return result(await engine.sessions.rewind(agent, message, restore));
    });
    core.reply('session.continueIn', async (raw) => {
      const { agent, connection, then } = OPS['session.continueIn'].input.parse(raw);
      commit({
        ...document,
        nodes: nodes.map((node) =>
          node.id === agent ? { ...node, data: { ...node.data, connection } } : node,
        ),
      });
      engine.sessions.open(agent);
      if (then)
        engine.sessions.send(
          agent,
          engine.catalog.adapterOf(connection),
          then.text,
          undefined,
          then.images,
        );
      return result();
    });
    // Your message, as the core's delivery admits it: its id the core's, its images live-only.
    core.reply('message', (raw) => {
      const { to, body, images } = OPS.message.input.parse(raw);
      const node = nodes.find((node) => node.id === to && node.type === 'agent');
      const id = crypto.randomUUID();
      engine.sessions.send(
        to,
        (node?.type === 'agent' ? node.data.adapter : undefined) ?? engine.catalog.defaultAdapter,
        body,
        undefined,
        images,
        undefined,
        'user',
        undefined,
        { id },
      );
      return result({ id });
    });
    core.reply('session.conversations', async (raw) => {
      const { agent } = OPS['session.conversations'].input.parse(raw);
      return read({ items: await backend.sessions(agent) });
    });
    core.reply('session.resumeConversation', async (raw) => {
      const { agent, conversation } = OPS['session.resumeConversation'].input.parse(raw);
      await engine.sessions.resume(agent, conversation);
      return result();
    });
    core.reply('session.options', async (raw) => {
      const { adapter, agent } = OPS['session.options'].input.parse(raw);
      return read(await backend.options(adapter, agent));
    });
    core.reply('session.mcpServers', async (raw) => {
      const { agent } = OPS['session.mcpServers'].input.parse(raw);
      return read({ items: await backend.mcp(agent) });
    });
    core.reply('session.changeMcpServer', async (raw) => {
      const { agent, server, change } = OPS['session.changeMcpServer'].input.parse(raw);
      return result({ items: await backend.changeMcp(agent, server, change) });
    });
    core.reply('session.interrupt', (raw) => {
      engine.sessions.stop(OPS['session.interrupt'].input.parse(raw).agent);
      return result();
    });
    core.reply('withdraw', (raw) => {
      const { id } = OPS.withdraw.input.parse(raw);
      const native = [...messageIds].find(([, kept]) => kept === id)?.[0] ?? id;
      for (const node of nodes)
        if (
          node.type === 'agent' &&
          engine.sessions.of(node.id).queued.some((one) => one.id === native)
        )
          engine.sessions.unqueue(node.id, native);
      return result({ reached: false, interrupted: false });
    });
    core.reply('reply', async (raw) => {
      const { to, answer } = OPS.reply.input.parse(raw);
      const input = {
        canvas,
        nodes,
        run: engine.run.snapshot(),
        sessions: engine.sessions.snapshot(),
        catalog: engine.catalog,
      };
      const need = needsOf(input).find((need) => needsItem(need, input).id === to);
      if (!need)
        return {
          ok: false,
          error: { code: 'not-found', sentence: 'That question is no longer current.' },
        };
      if (need.kind === 'hold')
        engine.run.decide(
          need.agent.id,
          need.ask.item.id,
          'text' in answer && answer.text !== undefined
            ? { reply: answer.text, ...(answer.images ? { images: answer.images } : {}) }
            : 'choice' in answer
              ? { choice: answer.choice }
              : { choice: '' },
        );
      else if (need.kind === 'prompt') {
        const { id } = need.prompt;
        const agent = need.agent.id;
        if ('permission' in answer)
          engine.sessions.answer(agent, id, answer.permission, answer.feedback);
        if ('answers' in answer)
          for (const [question, text] of Object.entries(answer.answers)) {
            const index =
              needsItem(need, input).questions?.findIndex((one) => one.id === question) ?? 0;
            engine.sessions.answerQuestion(
              agent,
              id,
              index,
              Array.isArray(text) ? text.join(', ') : text,
            );
          }
        if ('plan' in answer) engine.sessions.answerPlan(agent, id, answer.plan);
        if ('form' in answer)
          engine.sessions.answerElicitation(agent, id, answer.form.action, answer.form.values);
      }
      return result({ outcome: 'answered' });
    });
  }
  register();
  const stopViews = core.observeTopics((topic) => {
    for (const node of nodes)
      if (node.type === 'agent' && topic === `session:${canvas}:${encodeURIComponent(node.id)}`)
        engine.sessions.open(node.id);
  });
  return {
    activate: register,
    engine,
    manual: {
      record(agent: string, message: UserMessage): Promise<null> {
        engine.sessions.recordSubmission(agent, message.text, message.images);
        return Promise.resolve(null);
      },
    },
    update(next: CanvasDocument) {
      nodes = next.nodes;
      engine.update(nodes);
      publish();
    },
    dispose() {
      stopViews();
      for (const stop of stops) stop();
      engine.reset();
    },
  };
}
