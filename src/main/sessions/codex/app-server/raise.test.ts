import { describe, expect, it } from 'vitest';

import { AdapterPrompt, checkPromptAnswer, parseForm } from '../../../../shared/model/prompts';
import type { PromptAnswer } from '../../../../shared/model/prompts';
import {
  consentPrompt,
  implementPrompt,
  nativeResult,
  nonapproval,
  raised as raise,
} from './raise';
import type { Native, RaiseContext, Raised } from './raise';
import { recordedAsks, recordedPlaces } from './recorded';
import type { Fixture, RecordedAsk } from './recorded';
import { Translator } from './translate';

/*
 * B13 C5's maps for Codex's app server (B13 Design §9.2 C4, C5): what it asks as one of the
 * core's prompt kinds, with only structured facts for the classifier, and what Codex is told for
 * each answer, pinned by the 0.162.1 recordings where they exist and by its generated protocol
 * where no real Codex would produce the case.
 */

const PLACES = recordedPlaces('p1');

/** What a recorded request was raised with: the translator having read what came before it. */
function context(before: RecordedAsk['before'] = []): RaiseContext {
  const translator = new Translator({ places: PLACES });
  for (const { method, params } of before) translator.notification(method, params);
  return {
    places: PLACES,
    patch: (itemId) => translator.patch(itemId),
    mcpCall: (itemId) => translator.mcpCall(itemId),
    mcpCalls: () => translator.mcpCalls(),
  };
}

function ask(fixture: Fixture, nth = 0): RecordedAsk {
  const found = recordedAsks(fixture)[nth];
  if (!found) throw new Error(`${fixture} has no request #${String(nth)}`);
  return found;
}

/** A recorded request, raised as it was asked. */
function raisedFrom(fixture: Fixture, nth = 0) {
  const asked = ask(fixture, nth);
  return { asked, raised: raise(asked.method, asked.params, context(asked.before)) };
}

function prompt(result: Raised | undefined): { prompt: AdapterPrompt; native: Native } {
  if (result === undefined || 'declined' in result) throw new Error('not raised');
  // Whatever it raises is a whole, valid prompt.
  expect(AdapterPrompt.safeParse(result.prompt).success).toBe(true);
  return result;
}

/** What Codex is told for `answer`, checked as the core checks it first. */
function told(raised: { prompt: AdapterPrompt; native: Native }, answer: PromptAnswer): unknown {
  return nativeResult(raised.native, checkPromptAnswer(raised.prompt, answer));
}

const choice = (value: string): PromptAnswer => ({ kind: 'choice', value });
const NO_WORDS = { feedback: 'none', endsTurn: false } as const;

describe('a command’s approval', () => {
  it('omits a persistence decision whose complete label exceeds the bound, keeping once and cancel', () => {
    const result = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          command: 'echo ok',
          cwd: '/work/smoke/p1',
          availableDecisions: [
            'accept',
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ['echo', 'x'.repeat(600)],
              },
            },
            'cancel',
          ],
        },
        context(),
      ),
    );
    expect(result.prompt).toMatchObject({ omitted: true });
    expect(
      result.prompt.kind === 'approval' && result.prompt.choices.map(({ value }) => value),
    ).toEqual(['accept', 'cancel']);
    expect(told(result, choice('accept'))).toEqual({ decision: 'accept' });
    expect(() => told(result, choice('acceptWithExecpolicyAmendment'))).toThrow();
  });

  it('names the host a persistent network decision actually changes when it differs from the request', () => {
    const decision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'other.example.test', action: 'allow' },
      },
    };
    const result = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          command: 'curl safe.example.test',
          cwd: '/work/smoke/p1',
          networkApprovalContext: { host: 'safe.example.test' },
          availableDecisions: ['accept', decision, 'cancel'],
        },
        context(),
      ),
    );
    if (result.prompt.kind !== 'approval') throw new Error('Not an approval');
    const keeping = result.prompt.choices.find(({ hint }) => hint === 'allow_always');
    expect(keeping?.label).toContain('other.example.test');
    expect(keeping?.effects).toEqual({
      network: {
        host: 'other.example.test',
        allow: true,
        scope: 'user',
      },
    });
    expect(told(result, choice('applyNetworkPolicyAmendment:allow'))).toEqual({ decision });
  });
  it('offers each decision Codex lists, in its order, with its TUI’s words and their effects', () => {
    const { asked, raised } = raisedFrom('turns');
    const command = prompt(raised);
    expect(command.prompt).toEqual({
      kind: 'approval',
      title: 'Codex wants to run a command',
      summary: "printf 'hi' > hello.txt",
      reason: 'May I create hello.txt containing hi in the workspace?',
      subject: {
        type: 'command',
        command: `/bin/zsh -lc "printf 'hi' > hello.txt"`,
        cwd: '/work/smoke/p1',
      },
      answerIn: 'api',
      choices: [
        { value: 'accept', label: 'Yes, proceed', hint: 'allow_once', effects: {}, ...NO_WORDS },
        {
          value: 'acceptWithExecpolicyAmendment',
          label: "Yes, and don't ask again for commands that start with `printf 'hi' > hello.txt`",
          hint: 'allow_always',
          effects: {
            rules: [
              { behavior: 'allow', rule: "exec_command(printf 'hi' > hello.txt *)", scope: 'user' },
            ],
          },
          ...NO_WORDS,
        },
        {
          value: 'cancel',
          label: 'No, and tell Codex what to do differently',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: true,
        },
      ],
    });
    // As recorded: allowed once.
    expect(told(command, choice('accept'))).toEqual(asked.result);
    // The rule Codex offered, verbatim; and No, which stops the turn.
    expect(told(command, choice('acceptWithExecpolicyAmendment'))).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['/bin/zsh', '-lc', "printf 'hi' > hello.txt"],
        },
      },
    });
    expect(told(command, choice('cancel'))).toEqual({ decision: 'cancel' });
    expect(() => nativeResult(command.native, choice('acceptForSession'))).toThrow(/not offered/);
  });

  it('offers accept and cancel only where Codex lists no decisions, never a made-up “always”', () => {
    const { asked } = raisedFrom('turns');
    for (const availableDecisions of [undefined, null, []]) {
      const { prompt: shown } = prompt(
        raise(
          'item/commandExecution/requestApproval',
          { ...(asked.params as object), availableDecisions },
          context(),
        ),
      );
      expect(shown.kind === 'approval' && shown.choices.map(({ value }) => value)).toEqual([
        'accept',
        'cancel',
      ]);
    }
  });

  it('maps every decision of the protocol, a host’s too, to its hint and effects', () => {
    const amendment = (action: 'allow' | 'deny') => ({
      applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action } },
    });
    const network = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          kind: 'command',
          itemId: 'exec-1',
          reason: 'to fetch the page',
          networkApprovalContext: { host: 'example.com', protocol: 'https' },
          availableDecisions: [
            'accept',
            'acceptForSession',
            amendment('allow'),
            amendment('deny'),
            'decline',
            'cancel',
          ],
        },
        context(),
      ),
    );
    expect(network.prompt).toMatchObject({
      title: 'Codex wants to reach example.com',
      summary: 'example.com',
      reason: 'to fetch the page',
      subject: { type: 'network', host: 'example.com', protocol: 'https' },
    });
    expect(network.prompt.kind === 'approval' && network.prompt.choices).toEqual([
      {
        value: 'accept',
        label: 'Yes, just this once',
        hint: 'allow_once',
        effects: {},
        ...NO_WORDS,
      },
      {
        value: 'acceptForSession',
        label: 'Yes, and allow this host for this conversation',
        hint: 'allow_always',
        effects: { network: { host: 'example.com', allow: true, scope: 'session' } },
        ...NO_WORDS,
      },
      {
        value: 'applyNetworkPolicyAmendment:allow',
        label: 'Yes, and allow this host in the future',
        hint: 'allow_always',
        effects: { network: { host: 'example.com', allow: true, scope: 'user' } },
        ...NO_WORDS,
      },
      {
        value: 'applyNetworkPolicyAmendment:deny',
        label: 'No, and block this host in the future',
        hint: 'reject_always',
        effects: { network: { host: 'example.com', allow: false, scope: 'user' } },
        ...NO_WORDS,
      },
      {
        value: 'decline',
        label: 'No, continue without running it',
        hint: 'reject_once',
        effects: {},
        ...NO_WORDS,
      },
      {
        value: 'cancel',
        label: 'No, and tell Codex what to do differently',
        hint: 'reject_once',
        effects: {},
        feedback: 'none',
        endsTurn: true,
      },
    ]);
    expect(told(network, choice('applyNetworkPolicyAmendment:deny'))).toEqual({
      decision: amendment('deny'),
    });
    expect(told(network, choice('decline'))).toEqual({ decision: 'decline' });

    // A command's session decision keeps a rule for that command, for the session.
    const command = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          itemId: 'exec-2',
          command: '/bin/zsh -lc "npm test"',
          cwd: '/work/smoke/p1',
          availableDecisions: ['accept', 'acceptForSession', 'cancel'],
        },
        context(),
      ),
    );
    expect(command.prompt.kind === 'approval' && command.prompt.choices[1]).toEqual({
      value: 'acceptForSession',
      label: "Yes, and don't ask again for this command in this session",
      hint: 'allow_always',
      effects: { rules: [{ behavior: 'allow', rule: 'exec_command(npm test)', scope: 'session' }] },
      ...NO_WORDS,
    });
  });

  it('leaves out a decision it can’t word, saying so, and never sends part of one', () => {
    const left = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          itemId: 'exec-3',
          command: '/bin/zsh -lc "echo hi"',
          cwd: '/work/smoke/p1',
          availableDecisions: [
            'accept',
            // Codex's TUI hides a prefix it can't show on one line.
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', 'a\nb'] } },
            { somethingNew: {} },
            'cancel',
          ],
        },
        context(),
      ),
    );
    expect(left.prompt).toMatchObject({ omitted: true });
    expect(
      left.prompt.kind === 'approval' && left.prompt.choices.map(({ value }) => value),
    ).toEqual(['accept', 'cancel']);
  });

  it('asks before writing to a running command (writeStdin) by its own approval, on its command’s item', () => {
    const [, command, input] = recordedAsks('approvals');
    if (command === undefined || input === undefined) throw new Error('not recorded');
    // Two approvals of one item: each its own request.
    expect((input.params as { itemId: string }).itemId).toBe(
      (command.params as { itemId: string }).itemId,
    );
    const stdin = prompt(raise(input.method, input.params, context(input.before)));
    expect(stdin.prompt).toMatchObject({
      kind: 'approval',
      title: 'Codex wants to send input to a running command',
      reason: expect.stringMatching(/^Send input to an existing terminal\./) as unknown,
      subject: {
        type: 'command',
        command: "write_stdin --session-id 7627 'hi\n'",
        cwd: '/work/smoke/p1',
      },
    });
    expect(
      stdin.prompt.kind === 'approval' && stdin.prompt.choices.map(({ value }) => value),
    ).toEqual(['accept', 'cancel']);
    // As recorded: cancelled (which interrupted the turn).
    expect(told(stdin, choice('cancel'))).toEqual(input.result);
  });

  it('words a command’s additional permissions whole, or declines what it can’t show', () => {
    const base = {
      itemId: 'exec-4',
      command: '/bin/zsh -lc "npm install"',
      cwd: '/work/smoke/p1',
      availableDecisions: ['accept', 'cancel'],
    };
    const more = prompt(
      raise(
        'item/commandExecution/requestApproval',
        {
          ...base,
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: { read: null, write: ['/Users/someone/.npm'] },
          },
        },
        context(),
      ),
    );
    expect(more.prompt.summary).toBe('npm install, with network access; write ~/.npm');
    const glob = raise(
      'item/commandExecution/requestApproval',
      {
        ...base,
        additionalPermissions: {
          network: null,
          fileSystem: {
            read: null,
            write: null,
            entries: [{ path: { type: 'glob_pattern', pattern: '**/*.env' }, access: 'read' }],
          },
        },
      },
      context(),
    );
    expect(glob).toEqual({
      declined: expect.stringMatching(
        /Codex asked for permissions corrallm can’t show whole/,
      ) as unknown,
      result: { decision: 'cancel' },
    });
  });
});

describe('a file change’s approval', () => {
  it('names a directory-wide session grant instead of describing it as only the patch’s files', () => {
    const asked = ask('approvals');
    const result = prompt(
      raise(
        asked.method,
        {
          ...(asked.params as Record<string, unknown>),
          grantRoot: '/outside/shared',
        },
        context(asked.before),
      ),
    );
    if (result.prompt.kind !== 'approval') throw new Error('Not an approval');
    const keeping = result.prompt.choices.find(({ value }) => value === 'acceptForSession');
    expect(keeping?.label).toContain('/outside/shared');
    expect(keeping?.effects).toEqual({ directories: ['/outside/shared'] });
    expect(told(result, choice('acceptForSession'))).toEqual({ decision: 'acceptForSession' });
  });

  it('omits a directory grant it cannot name whole within its label, keeping once and cancel', () => {
    const asked = ask('approvals');
    const result = prompt(
      raise(
        asked.method,
        {
          ...(asked.params as Record<string, unknown>),
          grantRoot: `/outside/${'x'.repeat(600)}`,
        },
        context(asked.before),
      ),
    );
    expect(result.prompt).toMatchObject({ omitted: true });
    expect(
      result.prompt.kind === 'approval' && result.prompt.choices.map(({ value }) => value),
    ).toEqual(['accept', 'cancel']);
    expect(() => told(result, choice('acceptForSession'))).toThrow();
  });
  it('names its files and their diffs, and keeps a rule for them for the session', () => {
    const { asked, raised } = raisedFrom('approvals', 0);
    const change = prompt(raised);
    expect(change.prompt).toEqual({
      kind: 'approval',
      title: 'Codex wants to make these edits',
      summary: 'note.txt',
      detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'hi' }] },
      subject: { type: 'fileChange', files: [{ path: '/work/smoke/p1/note.txt', diff: 'hi\n' }] },
      answerIn: 'api',
      choices: [
        { value: 'accept', label: 'Yes, proceed', hint: 'allow_once', effects: {}, ...NO_WORDS },
        {
          value: 'acceptForSession',
          label: "Yes, and don't ask again for these files",
          hint: 'allow_always',
          effects: {
            rules: [
              { behavior: 'allow', rule: 'apply_patch(/work/smoke/p1/note.txt)', scope: 'session' },
            ],
          },
          ...NO_WORDS,
        },
        {
          value: 'cancel',
          label: 'No, and tell Codex what to do differently',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: true,
        },
      ],
    });
    expect(told(change, choice('accept'))).toEqual(asked.result);
    expect(told(change, choice('acceptForSession'))).toEqual({ decision: 'acceptForSession' });
  });

  it('keeps a folder it asks to write in as the session choice’s directory', () => {
    const { asked } = raisedFrom('approvals', 0);
    const change = prompt(
      raise(
        asked.method,
        { ...(asked.params as object), grantRoot: '/work/smoke/p1/out' },
        context(asked.before),
      ),
    );
    expect(change.prompt.kind === 'approval' && change.prompt.choices[1]?.effects).toEqual({
      directories: ['/work/smoke/p1/out'],
    });
  });

  it('names where a moved file goes as well as where it was', () => {
    const before = [
      {
        method: 'item/started',
        params: {
          item: {
            type: 'fileChange',
            id: 'move-1',
            status: 'inProgress',
            changes: [
              {
                path: '/work/smoke/p1/a.txt',
                kind: { type: 'update', move_path: '/work/smoke/p1/b.txt' },
                diff: '@@ -1 +1 @@\n-a\n+b\n',
              },
            ],
          },
        },
      },
    ];
    const moved = prompt(
      raise('item/fileChange/requestApproval', { itemId: 'move-1' }, context(before)),
    );
    expect(moved.prompt).toMatchObject({
      subject: {
        type: 'fileChange',
        files: [
          { path: '/work/smoke/p1/a.txt', diff: '@@ -1 +1 @@\n-a\n+b\n' },
          { path: '/work/smoke/p1/b.txt' },
        ],
      },
    });
  });

  it('declines a change it never saw, saying so', () => {
    expect(raise('item/fileChange/requestApproval', { itemId: 'nowhere' }, context())).toEqual({
      declined: expect.stringMatching(/files corrallm couldn’t see/) as unknown,
      result: { decision: 'cancel' },
    });
  });
});

describe('a permissions request', () => {
  it('offers this turn, with strict auto review, this session, or No, as Codex’s TUI does', () => {
    const { asked, raised } = raisedFrom('permissions');
    const permissions = prompt(raised);
    const network = (scope: 'turn' | 'session') => ({
      network: { host: '*', allow: true, scope },
    });
    expect(permissions.prompt).toEqual({
      kind: 'approval',
      title: 'Codex wants more permissions',
      summary: 'network access',
      reason: 'to fetch a page',
      subject: { type: 'permissions', network: true },
      answerIn: 'api',
      choices: [
        {
          value: 'turn',
          label: 'Yes, grant these permissions for this turn',
          hint: 'allow_once',
          effects: network('turn'),
          ...NO_WORDS,
        },
        {
          value: 'strict',
          label: 'Yes, grant for this turn with strict auto review',
          hint: 'allow_once',
          effects: network('turn'),
          ...NO_WORDS,
        },
        {
          value: 'session',
          label: 'Yes, grant these permissions for this session',
          hint: 'allow_always',
          effects: network('session'),
          ...NO_WORDS,
        },
        {
          value: 'deny',
          label: 'No, continue without permissions',
          hint: 'reject_once',
          effects: {},
          ...NO_WORDS,
        },
      ],
    });
    // As recorded: granted for the turn, with strict auto review.
    expect(told(permissions, choice('strict'))).toEqual(asked.result);
    const requested = (asked.params as { permissions: unknown }).permissions;
    expect(told(permissions, choice('turn'))).toEqual({ permissions: requested, scope: 'turn' });
    expect(told(permissions, choice('session'))).toEqual({
      permissions: requested,
      scope: 'session',
    });
    expect(told(permissions, choice('deny'))).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('names the folders it asks for, and declines what it can’t show whole', () => {
    const files = prompt(
      raise(
        'item/permissions/requestApproval',
        {
          itemId: 'perm-1',
          cwd: '/work/smoke/p1',
          reason: null,
          permissions: {
            network: null,
            fileSystem: {
              read: ['/work/smoke/data'],
              write: ['/Users/someone/.npm'],
              entries: [{ path: { type: 'path', path: '/work/smoke/logs' }, access: 'write' }],
            },
          },
        },
        context(),
      ),
    );
    expect(files.prompt).toMatchObject({
      summary: 'write ~/.npm, /work/smoke/logs; read /work/smoke/data',
      subject: {
        type: 'permissions',
        read: ['/work/smoke/data'],
        write: ['/Users/someone/.npm', '/work/smoke/logs'],
      },
    });
    expect(files.prompt.kind === 'approval' && files.prompt.choices[0]?.effects).toEqual({
      directories: ['/work/smoke/data', '/Users/someone/.npm', '/work/smoke/logs'],
    });
    const special = raise(
      'item/permissions/requestApproval',
      {
        itemId: 'perm-2',
        cwd: '/work/smoke/p1',
        reason: null,
        permissions: {
          network: null,
          fileSystem: {
            read: null,
            write: null,
            entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'write' }],
          },
        },
      },
      context(),
    );
    expect(special).toEqual({
      declined: expect.stringMatching(/can’t show whole/) as unknown,
      result: { permissions: {}, scope: 'turn' },
    });
  });
});

describe('Codex’s questions', () => {
  it('declines a question whose header cannot be shown whole, without silently truncating it', () => {
    const result = raise(
      'item/tool/requestUserInput',
      {
        questions: [
          {
            id: 'where',
            header: 'h'.repeat(201),
            question: 'Which region?',
            isOther: true,
            options: [],
          },
        ],
      },
      context(),
    );
    expect(result).toMatchObject({
      declined: expect.any(String) as unknown,
      result: { answers: {} },
    });
  });
  it('keeps its ids, its own-words option and its options; answers by id, words or a pick', () => {
    const { asked, raised } = raisedFrom('question');
    const question = prompt(raised);
    expect(question.prompt).toEqual({
      kind: 'question',
      title: 'Should the new file be named a.txt or b.txt?',
      answerIn: 'api',
      questions: [
        {
          id: 'filename',
          header: 'Filename',
          text: 'Should the new file be named a.txt or b.txt?',
          options: [
            { label: 'a.txt (Recommended)', description: 'Plan to create a file named a.txt.' },
            { label: 'b.txt', description: 'Plan to create a file named b.txt.' },
          ],
          multiple: false,
          other: true,
        },
      ],
    });
    // As recorded: answered in the user's own words.
    expect(told(question, { kind: 'questions', answers: { filename: { text: 'c.txt' } } })).toEqual(
      asked.result,
    );
    expect(
      told(question, { kind: 'questions', answers: { filename: { picked: ['b.txt'] } } }),
    ).toEqual({ answers: { filename: { answers: ['b.txt'] } } });
  });

  it('keeps five questions and more, each by its id; a secret one is marked so', () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      id: `q_${String(i)}`,
      header: `Q${String(i)}`,
      question: `Question ${String(i)}?`,
      isOther: true,
      isSecret: i === 4,
      options: i === 4 ? null : [{ label: 'Yes', description: '' }],
    }));
    const five = prompt(
      raise(
        'item/tool/requestUserInput',
        { itemId: 'call_5', questions, isBlocking: true },
        context(),
      ),
    );
    expect(five.prompt).toMatchObject({ title: 'Codex asks 5 questions' });
    expect(five.prompt.kind === 'question' && five.prompt.questions.map(({ id }) => id)).toEqual([
      'q_0',
      'q_1',
      'q_2',
      'q_3',
      'q_4',
    ]);
    expect(five.prompt.kind === 'question' && five.prompt.questions[4]).toEqual({
      id: 'q_4',
      header: 'Q4',
      text: 'Question 4?',
      options: [],
      multiple: false,
      other: true,
      secret: true,
    });
    expect(
      told(five, {
        kind: 'questions',
        answers: {
          q_0: { picked: ['Yes'] },
          q_1: { picked: ['Yes'] },
          q_2: { text: 'no' },
          q_3: { picked: ['Yes'] },
          q_4: { text: 'hunter2' },
        },
      }),
    ).toEqual({
      answers: {
        q_0: { answers: ['Yes'] },
        q_1: { answers: ['Yes'] },
        q_2: { answers: ['no'] },
        q_3: { answers: ['Yes'] },
        q_4: { answers: ['hunter2'] },
      },
    });
  });

  it('sends prototype-shaped question ids as own response keys without losing their answers', () => {
    const result = prompt(
      raise(
        'item/tool/requestUserInput',
        {
          questions: [
            { id: '__proto__', header: 'Pick', question: 'Which?', isOther: true, options: [] },
          ],
        },
        context(),
      ),
    );
    const answers = Object.fromEntries([['__proto__', { text: 'chosen' }]]);
    const response = told(result, { kind: 'questions', answers });
    expect(JSON.stringify(response)).toBe('{"answers":{"__proto__":{"answers":["chosen"]}}}');
  });

  it('declines questions it can’t key faithfully, never answering by the first match', () => {
    const twice = [
      { id: 'same', header: 'A', question: 'A?', isOther: true, isSecret: false, options: null },
      { id: 'same', header: 'B', question: 'B?', isOther: true, isSecret: false, options: null },
    ];
    expect(
      raise(
        'item/tool/requestUserInput',
        { itemId: 'c', questions: twice, isBlocking: true },
        context(),
      ),
    ).toEqual({
      declined: expect.stringMatching(/two questions under one id/) as unknown,
      result: { answers: {} },
    });
    const labels = [
      {
        id: 'pick',
        header: 'Pick',
        question: 'Which?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Same', description: '' },
          { label: 'Same', description: '' },
        ],
      },
    ];
    expect(
      raise(
        'item/tool/requestUserInput',
        { itemId: 'c', questions: labels, isBlocking: true },
        context(),
      ),
    ).toMatchObject({ result: { answers: {} } });
  });

  it('takes no other party’s answer as the user’s', () => {
    const { raised } = raisedFrom('question');
    const question = prompt(raised);
    expect(() =>
      nativeResult(question.native, {
        kind: 'questions',
        answers: { filename: { text: 'c.txt' } },
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    ).toThrow(/Only the user/);
  });
});

describe('Codex’s approval of an MCP tool call (F13)', () => {
  it('raised through an elicitation: an approval of that tool and its input, with Codex’s choices', () => {
    const [once, session, cancelled] = recordedAsks('mcp-approvals');
    if (!once || !session || !cancelled) throw new Error('not recorded');
    const approval = prompt(raise(once.method, once.params, context(once.before)));
    const rule = (scope: 'session' | 'user') => ({
      rules: [{ behavior: 'allow', rule: 'mcp__probe__save_note', scope }],
    });
    expect(approval.prompt).toEqual({
      kind: 'approval',
      title: 'Allow the probe MCP server to run tool "save_note"?',
      summary: 'a',
      subject: { type: 'mcpTool', server: 'probe', tool: 'save_note', input: { text: 'a' } },
      answerIn: 'api',
      choices: [
        {
          value: 'allow',
          label: 'Allow',
          description: 'Run the tool and continue',
          hint: 'allow_once',
          effects: {},
          ...NO_WORDS,
        },
        {
          value: 'session',
          label: 'Allow for this session',
          description: 'Run the tool and remember this choice for this session',
          hint: 'allow_always',
          effects: rule('session'),
          ...NO_WORDS,
        },
        {
          value: 'always',
          label: 'Always allow',
          description: 'Run the tool and remember this choice for future tool calls',
          hint: 'allow_always',
          effects: rule('user'),
          ...NO_WORDS,
        },
        {
          value: 'cancel',
          label: 'Cancel',
          description: 'Cancel this tool call',
          hint: 'reject_once',
          effects: {},
          ...NO_WORDS,
        },
      ],
    });
    // As recorded: once (no persist), then for the session; the turn went on after a cancel.
    expect(told(approval, choice('allow'))).toEqual(once.result);
    const second = prompt(raise(session.method, session.params, context(session.before)));
    expect(told(second, choice('session'))).toEqual(session.result);
    const third = prompt(raise(cancelled.method, cancelled.params, context(cancelled.before)));
    expect(third.prompt).toMatchObject({
      subject: { type: 'mcpTool', server: 'probe', tool: 'delete_note', input: { text: 'a' } },
    });
    expect(told(third, choice('cancel'))).toEqual(cancelled.result);
    expect(told(approval, choice('always'))).toEqual({
      action: 'accept',
      content: null,
      _meta: { persist: 'always' },
    });
  });

  it('offers to keep it only as Codex offers to', () => {
    const asked = ask('mcp-approvals', 0);
    const params = asked.params as { _meta: Record<string, unknown> };
    const values = (persist: unknown) => {
      const { prompt: shown } = prompt(
        raise(
          asked.method,
          { ...params, _meta: { ...params._meta, persist } },
          context(asked.before),
        ),
      );
      return shown.kind === 'approval' ? shown.choices.map(({ value }) => value) : [];
    };
    expect(values(undefined)).toEqual(['allow', 'cancel']);
    expect(values('session')).toEqual(['allow', 'session', 'cancel']);
    expect(values(['always'])).toEqual(['allow', 'always', 'cancel']);
  });

  it('declines an approval whose tool it can’t tell, naming the server, never its words', () => {
    const asked = ask('mcp-approvals', 0);
    // No call of the server's runs with those arguments.
    expect(raise(asked.method, asked.params, context())).toEqual({
      declined:
        'Codex asked to approve a tool call of MCP server “probe” corrallm couldn’t tell, so it was declined.',
      result: { action: 'decline', content: null, _meta: null },
    });
  });

  it('raised as a question (with Codex’s elicitations off): the same approval, answered by its labels', () => {
    const { asked, raised } = raisedFrom('mcp-question');
    const approval = prompt(raised);
    expect(approval.prompt).toMatchObject({
      kind: 'approval',
      title: 'Allow the probe MCP server to run tool "save_note"?',
      subject: { type: 'mcpTool', server: 'probe', tool: 'save_note', input: { text: 'a' } },
    });
    expect(approval.prompt.kind === 'approval' && approval.prompt.choices).toEqual([
      {
        value: 'allow',
        label: 'Allow',
        description: 'Run the tool and continue.',
        hint: 'allow_once',
        effects: {},
        ...NO_WORDS,
      },
      {
        value: 'session',
        label: 'Allow for this session',
        description: 'Run the tool and remember this choice for this session.',
        hint: 'allow_always',
        effects: {
          rules: [{ behavior: 'allow', rule: 'mcp__probe__save_note', scope: 'session' }],
        },
        ...NO_WORDS,
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Cancel this tool call.',
        hint: 'reject_once',
        effects: {},
        ...NO_WORDS,
      },
    ]);
    // As recorded.
    expect(told(approval, choice('allow'))).toEqual(asked.result);
  });

  it('keeps a model’s question that only looks like one a question', () => {
    const { asked } = raisedFrom('mcp-question');
    const params = asked.params as { questions: { isOther: boolean }[] };
    // Codex marks every question its model asks isOther: only Codex's own approval isn't.
    const looks = prompt(
      raise(
        asked.method,
        { ...params, questions: params.questions.map((q) => ({ ...q, isOther: true })) },
        context(asked.before),
      ),
    );
    expect(looks.prompt.kind).toBe('question');
  });
});

describe('an MCP server’s elicitations', () => {
  it('keeps a form of six fields a typed form, and gives its values typed (F14)', () => {
    const { asked, raised } = raisedFrom('mcp-approvals', 3);
    const form = prompt(raised);
    const parsed = parseForm((asked.params as { requestedSchema: unknown }).requestedSchema);
    expect(Object.keys(parsed?.schema.properties ?? {})).toHaveLength(6);
    expect(form.prompt).toEqual({
      kind: 'form',
      title: 'Fill in your profile.',
      server: 'probe',
      answerIn: 'api',
      form: { schema: parsed?.schema },
    });
    const values = (asked.result as { content: Record<string, never> }).content;
    // As recorded: accepted, its values typed.
    expect(told(form, { kind: 'form', action: 'accept', values })).toEqual(asked.result);
    expect(() =>
      told(form, { kind: 'form', action: 'accept', values: { ...values, age: 'old' } }),
    ).toThrow();
    expect(told(form, { kind: 'form', action: 'decline' })).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
  });

  it('keeps a link only in the form, worded by the core with its host', () => {
    const { asked, raised } = raisedFrom('mcp-approvals', 4);
    const link = prompt(raised);
    expect(link.prompt).toEqual({
      kind: 'form',
      title: 'MCP server “probe” asks you to open a link on auth.example.com',
      server: 'probe',
      answerIn: 'api',
      form: { url: 'https://auth.example.com/sign-in?state=probe' },
    });
    expect(JSON.stringify(link.prompt)).not.toContain('Sign in to continue');
    expect(told(link, { kind: 'form', action: 'accept' })).toEqual(asked.result);
  });

  it('declines a user verification, and a form it can’t show, naming the server only', () => {
    expect(
      raise(
        'mcpServer/elicitation/request',
        {
          serverName: 'bank',
          mode: 'openai/userVerification',
          _meta: null,
          title: 'Verify it’s you',
          description: 'Touch your key at https://bank.example.com/v?token=secret',
          challenge: 'AAAA',
        },
        context(),
      ),
    ).toEqual({
      declined:
        'MCP server “bank” asked to verify who you are, which corrallm can’t do, so it was declined.',
      result: { action: 'decline', content: null, _meta: null },
    });
    const nested = raise(
      'mcpServer/elicitation/request',
      {
        serverName: 'bank',
        mode: 'form',
        _meta: null,
        message: 'Paste https://bank.example.com/x?token=secret',
        requestedSchema: { type: 'object', properties: { a: { type: 'object' } } },
      },
      context(),
    );
    expect(nested).toEqual({
      declined: 'MCP server “bank” asked for a form corrallm can’t show, so it was declined.',
      result: { action: 'decline', content: null, _meta: null },
    });
  });
});

describe('the session’s own prompts', () => {
  it('asks to implement a plan in Codex’s Default, or to stay in Plan mode: no other mode', () => {
    const plan = prompt(implementPrompt('# Plan\n\n1. Do it\n'));
    expect(plan.prompt).toEqual({
      kind: 'plan',
      title: 'Implement this plan?',
      plan: '# Plan\n\n1. Do it\n',
      answerIn: 'api',
      choices: [
        {
          value: 'implement',
          label: 'Yes, implement this plan',
          hint: 'allow_once',
          effects: { mode: 'auto' },
          ...NO_WORDS,
        },
        {
          value: 'keep-planning',
          label: 'No, stay in Plan mode',
          hint: 'reject_once',
          effects: {},
          feedback: 'optional',
        },
      ],
    });
    expect(told(plan, choice('implement'))).toEqual({ approve: true });
    expect(told(plan, { kind: 'choice', value: 'keep-planning', feedback: ' Smaller ' })).toEqual({
      approve: false,
      feedback: 'Smaller',
    });
    expect(told(plan, choice('keep-planning'))).toEqual({ approve: false });
    // Another party's words are framed as theirs.
    expect(
      nativeResult(plan.native, {
        kind: 'choice',
        value: 'keep-planning',
        feedback: 'Smaller',
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    ).toEqual({
      approve: false,
      feedback: 'Lead (another party in corrallm, not the user) asks you to keep planning: Smaller',
    });
  });

  it('asks consent to use the user’s ChatGPT plan as a consent, theirs alone', () => {
    const consent = prompt(consentPrompt({ kind: 'chatgpt', plan: 'plus' }));
    expect(consent.prompt).toMatchObject({
      kind: 'approval',
      title: 'Use your ChatGPT plan here?',
      summary: 'Plus',
      subject: {
        type: 'consent',
        key: 'chatgpt-plan',
        text: expect.stringContaining(
          'App-server authentication has never been permitted',
        ) as unknown,
      },
    });
    expect(consent.prompt.kind === 'approval' && consent.prompt.choices).toEqual([
      { value: 'once', label: 'Yes', hint: 'allow_once', effects: {}, ...NO_WORDS },
      {
        value: 'always',
        label: "Yes, and don't ask again on this computer",
        hint: 'allow_always',
        ...NO_WORDS,
      },
      {
        value: 'no',
        label: 'No',
        hint: 'reject_once',
        effects: {},
        feedback: 'none',
        endsTurn: true,
      },
    ]);
    expect(told(consent, choice('always'))).toBe('always');
    expect(() =>
      nativeResult(consent.native, {
        kind: 'choice',
        value: 'once',
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    ).toThrow(/Only the user/);
  });
});

describe('what Codex is told for a request no one answers (C3)', () => {
  it('cancels a command or a change, grants no permission, answers no question, cancels a form', () => {
    const natives = (fixture: Fixture, nth = 0) => prompt(raisedFrom(fixture, nth).raised).native;
    expect(nonapproval(natives('turns'))).toEqual({ decision: 'cancel' });
    expect(nonapproval(natives('approvals'))).toEqual({ decision: 'cancel' });
    expect(nonapproval(natives('permissions'))).toEqual({ permissions: {}, scope: 'turn' });
    expect(nonapproval(natives('question'))).toEqual({ answers: {} });
    expect(nonapproval(natives('mcp-question'))).toEqual({ answers: {} });
    expect(nonapproval(natives('mcp-approvals', 0))).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    expect(nonapproval(natives('mcp-approvals', 3))).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
  });

  it('is undefined for a request that isn’t a prompt', () => {
    expect(raise('currentTime/read', {}, context())).toBeUndefined();
  });
});
