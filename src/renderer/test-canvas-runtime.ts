import type { CanvasDocument } from '../shared/model/canvas';
import type { SessionBackend } from '../shared/engine/transcript/receive';
import { NO_BACKEND } from '../shared/engine/transcript/receive';
import { Engine } from '../shared/engine/engine';
import { needs, needsOf, needsItem } from '../shared/engine/needs';
import { AgentId, MessageId } from '../shared/api/ids';
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
) {
  const engine = new Engine({
    catalog: runCatalog(),
    backend,
    now: Date.now,
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    connect: () => undefined,
  });
  let nodes = document.nodes;
  let rev = 0;
  const canvas = document.id;
  const publish = () => {
    const run = runView(engine.run.snapshot());
    const sessions = engine.sessions.snapshot();
    const views = Object.fromEntries(
      Object.entries(sessions).map(([id, session]) => [
        id,
        sessionView(
          AgentId.parse(id),
          engine.catalog.connectionOf(
            nodes.filter((node) => node.type === 'agent').find((node) => node.id === id)?.data ??
              {},
          ),
          session,
        ),
      ]),
    );
    const input = { canvas, nodes, run: engine.run.snapshot(), sessions, catalog: engine.catalog };
    const items = needs(input);
    const messages: MessageView[] = Object.entries(sessions).flatMap(([agent, session]) =>
      (session.submissions ?? []).map((message): MessageView => ({
        id: message.id,
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
    );
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
        top: { running: run.running, paused: run.paused ?? null, notices: [] },
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
    core.change({ topic: `needs:${canvas}`, rev: ++rev, replace: { items } });
  };
  const stops = [engine.run.subscribe(publish), engine.sessions.subscribe(publish)];
  engine.update(nodes);
  publish();
  const result = (value: object = {}) =>
    Promise.resolve({ ok: true as const, value: { ...value, revs: {} } });
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
  core.reply('message', async (raw) => {
    const { to, body, images } = OPS.message.input.parse(raw);
    const agent = nodes.find((node) => node.id === to && node.type === 'agent');
    engine.sessions.send(
      to,
      (agent?.type === 'agent' ? agent.data.adapter : undefined) ?? engine.catalog.defaultAdapter,
      body,
      undefined,
      images,
    );
    return result({ id: engine.sessions.of(to).submissions?.at(-1)?.id });
  });
  core.reply('session.interrupt', (raw) => {
    engine.sessions.stop(OPS['session.interrupt'].input.parse(raw).agent);
    return result();
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
  return {
    engine,
    update(next: CanvasDocument) {
      nodes = next.nodes;
      engine.update(nodes);
      publish();
    },
    dispose() {
      for (const stop of stops) stop();
      engine.reset();
    },
  };
}
