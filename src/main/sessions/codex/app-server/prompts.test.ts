import { describe, expect, it, vi } from 'vitest';

import type { SessionAnswer, SessionEvent } from '../../../../shared/session';
import { Prompts } from './prompts';
import { RECORDED_PLACES, recorded } from './recorded';

/** Prompts, with what they show recorded, and the patches the translator would know. */
function prompts() {
  const events: SessionEvent[] = [];
  const settled = vi.fn();
  const asking = new Prompts(
    {
      emit: (event) => events.push(event),
      settled,
      patch: (itemId) =>
        itemId === 'call_1'
          ? {
              summary: 'hello.txt',
              detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'hi' }] },
            }
          : undefined,
    },
    RECORDED_PLACES,
  );
  /** The prompt shown last. */
  const shown = () => {
    const prompt = events.filter((e) => e.type === 'permission' || e.type === 'question').at(-1);
    if (!prompt) throw new Error('nothing was asked');
    return prompt;
  };
  /** Asks, then answers it as the user did; resolves with what Codex is told. */
  const answered = async (method: string, params: unknown, answer: SessionAnswer, id = 0) => {
    const reply = asking.request(method, params, id);
    await vi.waitFor(() => {
      expect(asking.waiting).toBe(true);
    });
    asking.answer(shown().id, answer);
    return reply;
  };
  return { asking, events, settled, shown, answered };
}

/** The command approval Codex asked for in the recording. */
const recordedApproval = () => {
  const line = recorded('turns').find(
    ({ msg }) => msg.method === 'item/commandExecution/requestApproval',
  );
  if (!line) throw new Error('no approval recorded');
  return line.msg.params;
};

const permission = (answer: 'once' | 'always' | 'deny'): SessionAnswer => ({
  kind: 'permission',
  answer,
});

describe('Codex’s approvals, as prompts', () => {
  it('asks to run a command as Codex words it, offering to keep the rule it proposes', async () => {
    const { answered, shown, events } = prompts();
    await expect(
      answered('item/commandExecution/requestApproval', recordedApproval(), permission('once')),
    ).resolves.toEqual({ decision: 'accept' });
    expect(shown()).toEqual({
      type: 'permission',
      id: 'exec-8cdeae68-704e-4aec-bb77-68eac8816190:prompt',
      tool: 'exec_command',
      summary: "printf 'hi' > hello.txt",
      always: "Yes, and don't ask again for commands that start with `printf 'hi' > hello.txt`",
      title: 'May I create hello.txt containing hi in the workspace?',
    });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'waiting' });

    await expect(
      answered('item/commandExecution/requestApproval', recordedApproval(), permission('always')),
    ).resolves.toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['/bin/zsh', '-lc', "printf 'hi' > hello.txt"],
        },
      },
    });
    // No stops the turn, as the TUI's "No, and tell Codex what to do differently" does.
    await expect(
      answered('item/commandExecution/requestApproval', recordedApproval(), permission('deny')),
    ).resolves.toEqual({ decision: 'cancel' });
  });

  it('offers what Codex offers: this session, a host, or no “always” at all', async () => {
    const { answered, shown } = prompts();
    const base = { itemId: 'exec-2', command: '/bin/zsh -lc "curl example.com"' };
    await answered(
      'item/commandExecution/requestApproval',
      { ...base, availableDecisions: ['accept', 'acceptForSession', 'decline'] },
      permission('deny'),
    ).then((reply) => {
      // Without cancel on offer, No declines (it goes on without running it).
      expect(reply).toEqual({ decision: 'decline' });
    });
    expect(shown()).toMatchObject({
      summary: 'curl example.com',
      always: "Yes, and don't ask again for this command in this session",
    });
    await answered(
      'item/commandExecution/requestApproval',
      {
        ...base,
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
        availableDecisions: ['accept', 'acceptForSession', 'cancel'],
        reason: 'to fetch the page',
      },
      permission('always'),
    ).then((reply) => {
      expect(reply).toEqual({ decision: 'acceptForSession' });
    });
    expect(shown()).toMatchObject({
      summary: 'https://example.com',
      always: 'Yes, and allow this host for this conversation',
      title: 'Codex wants to reach example.com: to fetch the page',
    });
    await answered(
      'item/commandExecution/requestApproval',
      { ...base, availableDecisions: ['accept', 'cancel'] },
      permission('once'),
    );
    expect(shown()).toMatchObject({ always: null });
  });

  it('asks to apply a patch, showing its diff', async () => {
    const { answered, shown } = prompts();
    await expect(
      answered(
        'item/fileChange/requestApproval',
        { itemId: 'call_1', reason: null },
        permission('always'),
      ),
    ).resolves.toEqual({ decision: 'acceptForSession' });
    expect(shown()).toEqual({
      type: 'permission',
      id: 'call_1:prompt',
      tool: 'apply_patch',
      summary: 'hello.txt',
      always: "Yes, and don't ask again for these files",
      detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'hi' }] },
    });
  });

  it('asks for more permissions, for this turn or the session', async () => {
    const { answered, shown } = prompts();
    const params = {
      itemId: 'perm-1',
      reason: 'to install packages',
      permissions: {
        network: { enabled: true },
        fileSystem: { read: null, write: ['/Users/someone/.npm'] },
      },
    };
    await expect(
      answered('item/permissions/requestApproval', params, permission('always')),
    ).resolves.toEqual({
      permissions: params.permissions,
      scope: 'session',
    });
    expect(shown()).toMatchObject({
      tool: 'permissions',
      summary: 'network access; write ~/.npm',
      title: 'Codex wants more permissions: to install packages',
    });
    await expect(
      answered('item/permissions/requestApproval', params, permission('deny')),
    ).resolves.toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('asks Codex’s questions, and answers each by its id', async () => {
    const { answered, shown } = prompts();
    const params = {
      itemId: 'call_q',
      isBlocking: true,
      questions: [
        {
          id: 'db',
          header: 'Database',
          question: 'Which database?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Postgres', description: 'Recommended' },
            { label: 'SQLite', description: 'Simplest' },
          ],
        },
        {
          id: 'name',
          header: 'Name',
          question: 'What is it called?',
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    };
    await expect(
      answered('item/tool/requestUserInput', params, {
        kind: 'question',
        answers: ['SQLite', 'shop'],
      }),
    ).resolves.toEqual({ answers: { db: { answers: ['SQLite'] }, name: { answers: ['shop'] } } });
    expect(shown()).toEqual({
      type: 'question',
      id: 'call_q:prompt',
      questions: [
        {
          header: 'Database',
          text: 'Which database?',
          options: [
            { label: 'Postgres', description: 'Recommended' },
            { label: 'SQLite', description: 'Simplest' },
          ],
          multiple: false,
        },
        { header: 'Name', text: 'What is it called?', options: [], multiple: false },
      ],
    });
  });

  it('asks an MCP server’s form as questions, and gives its values typed', async () => {
    const { answered } = prompts();
    const params = {
      threadId: 't',
      turnId: 'u',
      serverName: 'tickets',
      mode: 'form',
      _meta: null,
      message: 'New ticket.',
      requestedSchema: {
        type: 'object',
        properties: {
          priority: {
            type: 'string',
            oneOf: [
              { const: 'p1', title: 'Urgent' },
              { const: 'p3', title: 'Low' },
            ],
          },
          points: { type: 'number', title: 'Points' },
          public: { type: 'boolean', title: 'Public?' },
        },
      },
    };
    await expect(
      answered('mcpServer/elicitation/request', params, {
        kind: 'question',
        answers: ['Urgent', '3', 'No'],
      }),
    ).resolves.toEqual({
      action: 'accept',
      content: { priority: 'p1', points: 3, public: false },
      _meta: null,
    });
  });

  it('withdraws a prompt Codex stops waiting for, and answers it anyway', async () => {
    const { asking, events, settled } = prompts();
    const reply = asking.request('item/commandExecution/requestApproval', recordedApproval(), 7);
    await vi.waitFor(() => {
      expect(asking.waiting).toBe(true);
    });
    asking.resolved(7);
    await expect(reply).resolves.toEqual({ decision: 'cancel' });
    expect(events).toContainEqual({
      type: 'withdrawn',
      id: 'exec-8cdeae68-704e-4aec-bb77-68eac8816190:prompt',
    });
    expect(settled).toHaveBeenCalled();
    expect(() => {
      asking.answer('exec-8cdeae68-704e-4aec-bb77-68eac8816190:prompt', permission('once'));
    }).toThrow(/no longer asked/);
  });

  it('refuses what it does not handle, and tells the time', async () => {
    const { asking } = prompts();
    await expect(asking.request('item/tool/call', {}, 1)).rejects.toMatchObject({ code: -32601 });
    await expect(asking.request('account/chatgptAuthTokens/refresh', {}, 2)).rejects.toMatchObject({
      code: -32601,
    });
    const { currentTimeAt } = (await asking.request('currentTime/read', { threadId: 't' }, 3)) as {
      currentTimeAt: number;
    };
    expect(Math.abs(currentTimeAt - Date.now() / 1000)).toBeLessThan(5);
  });
});
