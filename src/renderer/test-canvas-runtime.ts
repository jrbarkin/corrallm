import type { CanvasDocument } from '../shared/model/canvas';
import type { Session, Entry, Prompt } from '../shared/model/session';
import { isOpen, NEW_SESSION } from '../shared/model/session';
import type { Run } from '../shared/model/run';
import type { MessageImage, SessionMode, SessionAnswer, SessionOptions } from '../shared/session';
import { isSessionMode } from '../shared/session';
import type { ConnectionId } from '../shared/adapter';
import { OPS } from '../shared/api/registry';
import { AgentId, MessageId } from '../shared/api/ids';
import { runView, sessionView } from '../shared/model/views';
import type { MessageView } from '../shared/model/views';
import { needs, needsOf, needsItem } from '../shared/model/needs-selectors';
import * as AgentOps from '../shared/model/agent-ops';
import { catalog } from './catalog';
import { runCatalog } from './graph/agents';
import type { fakeCore } from './test-api';
import { fakeSessions } from './test-sessions';
import type { SessionReplies } from './test-sessions';

/** X11 removes these legacy fixture entries and their string/array answers together. */
function legacyQuestionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part: unknown) => typeof part === 'string')) {
    return value.join(', ');
  }
  throw new Error('This question fixture takes the old card’s answers.');
}

/** Scripted operation/topic fixture. It runs no queue, driver, retry loop or checkpoint. */
export function canvasRuntime(
  core: ReturnType<typeof fakeCore>,
  document: CanvasDocument,
  replies: SessionReplies = fakeSessions().replies,
  commit: (next: CanvasDocument) => void = () => undefined,
) {
  let nodes = document.nodes;
  const canvas = document.id;
  const lookups = runCatalog();
  let run: Run = { running: false, agents: {} };
  const sessions: Record<string, Session> = {};
  const messages = new Map<string, MessageView>();
  const opened = new Map<string, ConnectionId>();
  const refused = new Set<string>();
  const result = (value: object = {}) => ({ ok: true as const, value: { ...value, revs: {} } });
  const of = (id: string): Session => sessions[id] ?? { ...NEW_SESSION, entries: [], queued: [] };
  const connectionOf = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    return lookups.connectionOf(node?.type === 'agent' ? node.data : {});
  };
  const input = () => ({ canvas, nodes, run, sessions, catalog: lookups });
  function publish() {
    const projected = { ...run, agents: { ...run.agents } };
    if (run.individualPauses !== undefined || run.groupPauses !== undefined)
      for (const node of nodes)
        if (node.type === 'agent') {
          const parents: string[] = [];
          let parent = node.parentId;
          while (parent) {
            parents.push(parent);
            parent = nodes.find((n) => n.id === parent)?.parentId;
          }
          const paused =
            (run.individualPauses ?? []).some((p) => p.id === node.id) ||
            (run.groupPauses ?? []).some((p) => parents.includes(p.id));
          projected.agents[node.id] = {
            ...(projected.agents[node.id] ?? { status: 'waiting', outcomes: {} }),
            paused,
          };
        }
    const view = runView(projected);
    const old = core.state(`run:${canvas}`);
    if (!old) core.snapshot(`run:${canvas}`, view);
    else
      core.change({
        topic: `run:${canvas}`,
        rev: old.rev + 1,
        top: { running: view.running, paused: view.paused ?? null, notices: [...view.notices] },
        agents: {
          set: view.agents,
          remove: Object.keys(old.state.agents)
            .filter((id) => !Object.hasOwn(view.agents, id))
            .map((id) => AgentId.parse(id)),
        },
        groups: {
          set: view.groups,
          remove: Object.keys(old.state.groups)
            .filter((id) => !Object.hasOwn(view.groups, id))
            .map((id) => AgentId.parse(id)),
        },
      });
    const views = Object.fromEntries(
      nodes
        .filter((n) => n.type === 'agent')
        .map((n) => [n.id, sessionView(AgentId.parse(n.id), connectionOf(n.id), of(n.id))]),
    );
    const agents = Object.fromEntries(Object.entries(views).map(([id, v]) => [id, v.summary]));
    const oldSessions = core.state(`sessions:${canvas}`);
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
    for (const [id, v] of Object.entries(views)) {
      const topic = `session:${canvas}:${encodeURIComponent(id)}` as const;
      const before = core.state(topic);
      if (!before) core.snapshot(topic, v);
      else
        core.change({
          topic,
          rev: before.rev + 1,
          summary: v.summary,
          entries: { upsert: Object.values(v.entries), order: v.order },
        });
    }
    const items = Object.fromEntries(messages);
    const oldMessages = core.state(`messages:${canvas}`);
    if (!oldMessages)
      core.snapshot(`messages:${canvas}`, {
        items,
        order: [...messages.keys()].map((id) => MessageId.parse(id)),
        next: '',
      });
    else
      core.change({
        topic: `messages:${canvas}`,
        rev: oldMessages.rev + 1,
        set: items,
        remove: Object.keys(oldMessages.state.items)
          .filter((id) => !messages.has(id))
          .map((id) => MessageId.parse(id)),
        order: [...messages.keys()].map((id) => MessageId.parse(id)),
        next: '',
      });
    core.change({
      topic: `needs:${canvas}`,
      rev: (core.state(`needs:${canvas}`)?.rev ?? 0) + 1,
      replace: { items: needs(input()) },
    });
  }
  function setSession(agent: string, session: Session) {
    sessions[agent] = session;
    publish();
  }
  function put(agent: string, entry: Entry) {
    const session = of(agent);
    const at = session.entries.findIndex((e) => e.id === entry.id);
    const entries = [...session.entries];
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
    setSession(agent, {
      ...session,
      entries,
      prompts: entries.filter((e): e is Prompt => isOpen(e)),
    });
  }
  const stopEvents = replies.onEvent((agent, connection, event) => {
    if (connection !== connectionOf(agent)) return;
    const current = of(agent);
    switch (event.type) {
      case 'started':
        setSession(agent, { ...current, ...event, status: 'idle' });
        break;
      case 'status':
        setSession(agent, { ...current, status: event.status });
        break;
      case 'mode':
        setSession(agent, { ...current, mode: event.mode });
        break;
      case 'model':
        setSession(agent, { ...current, model: event.model });
        break;
      case 'effort':
        setSession(agent, { ...current, effort: event.effort });
        break;
      case 'usage':
        setSession(agent, { ...current, usage: event.usage });
        break;
      case 'commands':
        setSession(agent, { ...current, commands: event.commands });
        break;
      case 'tasks':
        setSession(agent, { ...current, tasks: event.tasks });
        break;
      case 'suggestion':
        setSession(agent, { ...current, suggestion: event.text });
        break;
      case 'asking':
        setSession(agent, { ...current, asking: event.asks });
        break;
      case 'unheard':
        setSession(agent, { ...current, unheard: event.text });
        put(agent, { kind: 'notice', id: crypto.randomUUID(), level: 'warning', text: event.text });
        break;
      case 'text':
      case 'thinking': {
        const previous = current.entries.find((e) => e.id === event.id);
        put(agent, {
          ...event,
          kind: event.type,
          text:
            (previous && (previous.kind === 'text' || previous.kind === 'thinking')
              ? previous.text
              : '') + event.text,
          ...(event.type === 'thinking' ? { seconds: 1 } : {}),
        } as Entry);
        break;
      }
      case 'user': {
        if (![...messages.values()].some((m) => m.delivery?.as === event.id)) {
          const id = crypto.randomUUID();
          messages.set(id, {
            id,
            canvas,
            from: 'you',
            to: `agent:${agent}`,
            kind: 'text',
            body: event.text,
            at: Date.now(),
            origin: 'manual',
            state: 'delivered',
            delivery: { as: event.id, at: Date.now(), attempt: 1 },
          });
        }
        put(agent, {
          ...event,
          kind: 'user',
          reached: true,
          conversation: lookups.adapterOf(connection),
        });
        break;
      }
      case 'tool':
      case 'todos':
      case 'permission':
      case 'question':
      case 'plan':
      case 'elicitation':
      case 'notice':
        put(agent, { ...event, kind: event.type } as Entry);
        break;
      case 'withdrawn':
        setSession(agent, {
          ...current,
          entries: current.entries.map((e) => (e.id === event.id ? { ...e, withdrawn: true } : e)),
        });
        break;
      case 'cleared':
        setSession(agent, {
          ...current,
          entries: [...current.entries, { kind: 'cleared', id: event.id }],
          queued: [],
        });
        break;
      case 'end': {
        for (const [id, message] of messages)
          if (event.messages.includes(message.delivery?.as ?? id))
            messages.set(id, { ...message, state: 'replied', turn: event.result });
        put(agent, {
          kind: 'end',
          id: `${event.messages.at(-1) ?? 'native'}:end`,
          seconds: event.seconds,
          interrupted: event.result.status === 'cancelled',
          ...(event.result.status === 'failed' ? { failed: true } : {}),
          result: event.result,
        });
        setSession(agent, { ...of(agent), status: 'idle' });
        break;
      }
      case 'closed': {
        opened.delete(agent);
        refused.delete(agent);
        const rest = { ...current };
        delete rest.running;
        setSession(agent, { ...rest, status: 'idle' });
        break;
      }
      case 'history':
        for (const item of event.events) {
          if (item.type === 'end')
            put(agent, {
              kind: 'end',
              id: `${item.messages.at(-1) ?? 'native'}:end`,
              seconds: item.seconds,
              interrupted: item.result.status === 'cancelled',
              ...(item.result.status === 'failed' ? { failed: true } : {}),
              result: item.result,
            });
          else if (item.type === 'user')
            put(agent, {
              ...item,
              kind: 'user',
              reached: true,
              conversation: lookups.adapterOf(connection),
            });
          else if ('id' in item) {
            const { type, ...entry } = item;
            put(agent, { ...entry, kind: type } as Entry);
          }
        }
        break;
    }
  });
  async function open(agent: string, again = false) {
    const connection = connectionOf(agent);
    if (!again && opened.get(agent) === connection) return !refused.has(agent);
    const node = nodes.find((n) => n.id === agent);
    const settings =
      node?.type === 'agent' ? (node.data.settings?.[lookups.adapterOf(connection)] ?? {}) : {};
    const options: SessionOptions = {
      connection,
      model: settings.model ?? null,
      mode: settings.mode && isSessionMode(settings.mode) ? settings.mode : null,
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(node?.type === 'agent' && node.data.role ? { role: node.data.role } : {}),
    };
    opened.set(agent, connection);
    setSession(agent, {
      ...of(agent),
      running: {
        ...(options.model ? { model: options.model } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.role ? { role: options.role } : {}),
      },
    });
    try {
      await replies.start(agent, options);
      refused.delete(agent);
      return true;
    } catch (error) {
      refused.add(agent);
      const text = error instanceof Error ? error.message : String(error);
      if (!of(agent).entries.some((e) => e.kind === 'notice' && e.text === text))
        put(agent, { kind: 'notice', id: crypto.randomUUID(), level: 'error', text });
      return false;
    }
  }
  async function send(agent: string, text: string, images?: MessageImage[], record = false) {
    const id = crypto.randomUUID();
    const busy = of(agent).status !== 'idle';
    messages.set(id, {
      id,
      canvas,
      from: 'you',
      to: `agent:${agent}`,
      kind: 'text',
      body: text,
      at: Date.now(),
      origin: 'manual',
      state: record ? 'replied' : 'pending',
      ...(record ? {} : { delivery: { as: id, at: Date.now(), attempt: 1 } }),
    });
    publish();
    if (record) return result({ id });
    if (!(await open(agent)) || busy) return result({ id });
    const message = messages.get(id);
    if (message) messages.set(id, { ...message, state: 'delivered' });
    const rest = { ...of(agent) };
    delete rest.suggestion;
    setSession(agent, { ...rest, status: 'working' });
    put(agent, { kind: 'user', id, text, ...(images ? { images } : {}) });
    await replies.send(agent, { id, text, ...(images ? { images } : {}) });
    return result({ id });
  }
  function register() {
    for (const op of ['run.start', 'run.stop', 'run.resume'] as const)
      core.reply(op, () => {
        const rest = { ...run };
        delete rest.paused;
        run = {
          ...rest,
          running: op !== 'run.stop',
          ...(op === 'run.stop' ? { paused: true } : {}),
        };
        publish();
        return Promise.resolve(result());
      });
    for (const op of ['run.pause', 'run.kill', 'run.unpause'] as const)
      core.reply(op, (raw) => {
        const { target } = OPS[op].input.parse(raw);
        const id = 'agent' in target ? target.agent : target.group;
        const field = 'agent' in target ? 'individualPauses' : 'groupPauses';
        run = {
          ...run,
          [field]:
            op === 'run.unpause'
              ? (run[field] ?? []).filter((p) => p.id !== id)
              : [...(run[field] ?? []), { id, by: 'you' }],
        };
        publish();
        return Promise.resolve(result(op === 'run.unpause' ? { held: [] } : {}));
      });
    core.reply('session.open', async (raw) => {
      const { agent } = OPS['session.open'].input.parse(raw);
      await open(agent, refused.has(agent));
      return result();
    });
    core.reply('message', async (raw) => {
      const args = OPS.message.input.parse(raw);
      return send(args.to, args.body, args.images);
    });
    core.reply('session.viewCommand', async (raw) => {
      const args = OPS['session.viewCommand'].input.parse(raw);
      return send(args.agent, args.text, undefined, true);
    });
    core.reply('withdraw', (raw) => {
      messages.delete(OPS.withdraw.input.parse(raw).id);
      publish();
      return Promise.resolve(result({ reached: false, interrupted: false }));
    });
    for (const op of ['session.setMode', 'session.setModel', 'session.setEffort'] as const)
      core.reply(op, async (raw) => {
        const args = OPS[op].input.parse(raw);
        const agent = args.agent;
        if ('mode' in args) await replies.setMode(agent, args.mode as SessionMode);
        if ('model' in args) await replies.setModel(agent, args.model);
        if ('effort' in args) await replies.setEffort(agent, args.effort);
        const change =
          'mode' in args
            ? { mode: args.mode }
            : 'model' in args
              ? { model: args.model }
              : { effort: args.effort };
        setSession(agent, { ...of(agent), ...change } as Session);
        commit(
          AgentOps.setSettings(
            { ...document, nodes },
            { agent, adapter: lookups.adapterOf(connectionOf(agent)), change },
          ).next,
        );
        return result();
      });
    core.reply('session.interrupt', async (raw) => {
      await replies.interrupt(OPS['session.interrupt'].input.parse(raw).agent);
      return result();
    });
    core.reply('session.stopTask', async (raw) => {
      const { agent, task } = OPS['session.stopTask'].input.parse(raw);
      await replies.stopTask(agent, task);
      return result();
    });
    core.reply('session.options', async (raw) => {
      const { adapter, agent } = OPS['session.options'].input.parse(raw);
      return { ok: true, value: await replies.options(adapter, agent) };
    });
    core.reply('session.conversations', async (raw) => ({
      ok: true,
      value: { items: await replies.sessions(OPS['session.conversations'].input.parse(raw).agent) },
    }));
    core.reply('session.mcpServers', async (raw) => ({
      ok: true,
      value: { items: await replies.mcp(OPS['session.mcpServers'].input.parse(raw).agent) },
    }));
    core.reply('session.changeMcpServer', async (raw) => {
      const { agent, server, change } = OPS['session.changeMcpServer'].input.parse(raw);
      return result({ items: await replies.changeMcp(agent, server, change) });
    });
    core.reply('session.rewindPreview', async (raw) => {
      const { agent, message } = OPS['session.rewindPreview'].input.parse(raw);
      return { ok: true, value: await replies.previewRewind(agent, message) };
    });
    core.reply('session.rewind', async (raw) => {
      const { agent, message, restore } = OPS['session.rewind'].input.parse(raw);
      const changed = await replies.rewind(agent, message, restore);
      if (changed.conversation) {
        setSession(agent, { ...NEW_SESSION, entries: [], queued: [] });
        await open(agent, true);
      }
      return result(changed);
    });
    core.reply('session.resumeConversation', async (raw) => {
      const { agent, conversation } = OPS['session.resumeConversation'].input.parse(raw);
      await replies.resume(agent, conversation);
      setSession(agent, { ...NEW_SESSION, entries: [], queued: [] });
      await open(agent, true);
      return result();
    });
    for (const op of ['session.restart', 'session.newConversation'] as const)
      core.reply(op, async (raw) => {
        const { agent } = OPS[op].input.parse(raw);
        if (op === 'session.newConversation') {
          await replies.fresh(agent, lookups.adapterOf(connectionOf(agent)));
          setSession(agent, { ...NEW_SESSION, entries: [], queued: [] });
        } else await replies.close(agent);
        await open(agent, true);
        return result();
      });
    core.reply('session.continueIn', async (raw) => {
      const { agent, connection, then } = OPS['session.continueIn'].input.parse(raw);
      await replies.close(agent);
      commit(
        AgentOps.setConnection(
          { ...document, nodes },
          { agent, connection },
          { catalog: catalog(), defaultAdapter: lookups.defaultAdapter },
        ).next,
      );
      await open(agent, true);
      return then ? send(agent, then.text, then.images) : result();
    });
    core.reply('reply', async (raw) => {
      const { to, answer } = OPS.reply.input.parse(raw);
      const need = needsOf(input()).find((n) => needsItem(n, input()).id === to);
      if (!need)
        return {
          ok: false,
          error: { code: 'not-found', sentence: 'That question is no longer current.' },
        };
      if (need.kind === 'prompt') {
        const agent = need.agent.id,
          prompt = need.prompt;
        if ('answers' in answer && prompt.kind === 'question') {
          const fields = needsItem(need, input()).questions ?? [];
          const questions = prompt.questions.map((q, i) => {
            const key = fields[i]?.id;
            const value = key === undefined ? undefined : answer.answers[key];
            return value === undefined ? q : { ...q, answer: legacyQuestionText(value) };
          });
          put(agent, { ...prompt, questions });
          if (questions.every((q) => q.answer !== undefined))
            await replies.answer(agent, prompt.id, {
              kind: 'question',
              answers: questions.map((q) => q.answer ?? ''),
            });
          return result({ outcome: 'answered' });
        }
        const native: SessionAnswer =
          'permission' in answer
            ? {
                kind: 'permission',
                answer: answer.permission,
                ...(answer.feedback ? { feedback: answer.feedback } : {}),
              }
            : 'answers' in answer
              ? {
                  kind: 'question',
                  answers: Object.values(answer.answers).map(legacyQuestionText),
                }
              : 'plan' in answer
                ? { kind: 'plan', answer: answer.plan }
                : 'form' in answer
                  ? {
                      kind: 'elicitation',
                      action: answer.form.action,
                      ...(answer.form.values ? { values: answer.form.values } : {}),
                    }
                  : { kind: 'permission', answer: 'deny' };
        await replies.answer(agent, prompt.id, native);
        put(agent, {
          ...prompt,
          ...('permission' in answer
            ? {
                answer: answer.permission,
                ...(answer.feedback ? { feedback: answer.feedback } : {}),
              }
            : 'plan' in answer
              ? { answer: answer.plan }
              : 'answers' in answer && prompt.kind === 'question'
                ? {
                    questions: prompt.questions.map((q, i) => ({
                      ...q,
                      answer: legacyQuestionText(Object.values(answer.answers)[i]),
                    })),
                  }
                : { answer: 'form' in answer ? answer.form.action : undefined }),
        } as Entry);
        setSession(agent, { ...of(agent), status: 'working' });
      }
      return result({ outcome: 'answered' });
    });
  }
  register();
  publish();
  const stopViews = core.observeTopics((topic) => {
    for (const node of nodes)
      if (node.type === 'agent' && topic === `session:${canvas}:${encodeURIComponent(node.id)}`)
        void open(node.id);
  });
  return {
    activate: register,
    messages(next: readonly MessageView[]) {
      messages.clear();
      for (const item of next) messages.set(item.id, item);
      publish();
    },
    run(next?: Run) {
      if (next) {
        run = next;
        publish();
      }
      return run;
    },
    session(agent: string, next?: Session) {
      if (next) setSession(agent, next);
      return of(agent);
    },
    update(next: CanvasDocument) {
      nodes = next.nodes;
      publish();
    },
    dispose() {
      stopViews();
      stopEvents();
    },
  };
}
