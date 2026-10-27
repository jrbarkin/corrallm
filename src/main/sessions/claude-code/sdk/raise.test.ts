import type { ElicitationRequest, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { AdapterPrompt, checkPromptAnswer } from '../../../../shared/model/prompts';
import type { PromptAnswer } from '../../../../shared/model/prompts';
import { DENIED, DENIED_WITH_FEEDBACK } from './prompts';
import {
  declined,
  elicitationPrompt,
  elicitationResult,
  permissionResult,
  signalsOf,
  toolPrompt,
} from './raise';
import type { Raised, ToolOptions } from './raise';
import { RECORDED_PLACES, recorded } from './recorded';
import type { Fixture, RecordedElicitation, RecordedRequest } from './recorded';

/*
 * B13 C4's maps (Design §9.2 C4, C5) on what the real CLI asked, recorded: the prompt each
 * permission request and MCP server's request raises, the facts the core's classifier reads, and
 * what the CLI is told for each choice.
 */

/** The permission requests the real CLI made in a recorded session, in order. */
function requests(fixture: Fixture): RecordedRequest[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'canUseTool' ? [item.data] : []));
}
/** What the real CLI was told for each, in order. */
function results(fixture: Fixture): unknown[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'canUseToolResult' ? [item.data] : []));
}
function elicitations(fixture: Fixture): RecordedElicitation[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'elicitation' ? [item.data] : []));
}
function request(fixture: Fixture, index: number): RecordedRequest {
  const found = requests(fixture)[index];
  if (!found) throw new Error(`no request ${String(index)} in ${fixture}`);
  return found;
}

/** Claude Code's modes the session offers (none bypass-disabled). */
const MODES = ['manual', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const;
const raise = (asked: RecordedRequest, modes: readonly string[] = MODES): Raised =>
  toolPrompt(asked.tool, asked.input, asked.opts as unknown as ToolOptions, {
    places: RECORDED_PLACES,
    modes,
  });
/** The prompt a request raises, checked against the protocol as the core checks it. */
function prompted(raised: Raised) {
  if (!('prompt' in raised)) throw new Error(`declined: ${raised.declined}`);
  expect(AdapterPrompt.safeParse(raised.prompt).success).toBe(true);
  return raised;
}
const choice = (value: string, extra: Partial<PromptAnswer> = {}): PromptAnswer =>
  ({ kind: 'choice', value, ...extra }) as PromptAnswer;

describe('signals, from the facts the CLI gives (never its words)', () => {
  it('reads a project ask rule and a safety check from the recordings', () => {
    expect(signalsOf('Read', request('ask-rule', 0).opts as unknown as ToolOptions)).toEqual({
      askRule: true,
    });
    expect(signalsOf('Write', request('safety-check', 0).opts as unknown as ToolOptions)).toEqual({
      safetyCheck: true,
    });
  });

  it('takes an MCP tool the server’s policy only asks about as a person’s', () => {
    expect(
      signalsOf(
        'mcp__tracker__file_issue',
        request('mcp-elicitations', 0).opts as unknown as ToolOptions,
      ),
    ).toEqual({ requiresUser: true });
  });

  it('finds nothing in a working-folder or suggestion request, nor in the built-in question and plan', () => {
    expect(
      signalsOf('Read', request('ask-rule', 1).opts as unknown as ToolOptions),
    ).toBeUndefined();
    expect(
      signalsOf('Bash', request('suggestions-and-denials', 0).opts as unknown as ToolOptions),
    ).toBeUndefined();
    const [question] = requests('question-and-plan');
    expect(question?.opts).toMatchObject({ requiresUserInteraction: true });
    expect(signalsOf('AskUserQuestion', question?.opts as unknown as ToolOptions)).toBeUndefined();
    expect(
      signalsOf('ExitPlanMode', request('plan-into-mode', 0).opts as unknown as ToolOptions),
    ).toBeUndefined();
  });

  it('maps every reason the runtime passes, and takes one it does not know as a person’s', () => {
    const base = { toolUseID: 't', requestId: 'r' };
    const of = (options: Record<string, unknown>, tool = 'Bash') =>
      signalsOf(tool, { ...base, ...options } as unknown as ToolOptions);
    expect(of({ matchedAskRule: { source: 'userSettings', toolName: 'Bash' } })).toEqual({
      askRule: true,
    });
    expect(of({ decisionReasonType: 'rule' })).toEqual({ askRule: true });
    expect(of({ decisionReasonType: 'hook' })).toEqual({ askRule: true });
    expect(of({ decisionReasonType: 'safetyCheck' })).toEqual({ safetyCheck: true });
    // A command's parts can hide a safety check only a person may approve (its flag isn't passed).
    expect(of({ decisionReasonType: 'subcommandResults' })).toEqual({ safetyCheck: true });
    expect(of({ decisionReasonType: 'classifier' })).toEqual({ requiresUser: true });
    expect(of({ decisionReasonType: 'other' })).toEqual({ requiresUser: true });
    expect(of({ decisionReasonType: 'somethingNew' })).toEqual({ requiresUser: true });
    expect(of({ serverPolicyAskOnly: true })).toEqual({ requiresUser: true });
    expect(of({ requiresUserInteraction: true })).toEqual({ requiresUser: true });
    for (const ordinary of [
      'mode',
      'workingDir',
      'sandboxOverride',
      'permissionPromptTool',
      'asyncAgent',
    ]) {
      expect(of({ decisionReasonType: ordinary })).toBeUndefined();
    }
    expect(of({})).toBeUndefined();
    // Only the built-in tools are excepted: an MCP server's tool of the same name is not.
    expect(
      of(
        { requiresUserInteraction: true, mcpServer: { name: 'evil', source: 'project' } },
        'AskUserQuestion',
      ),
    ).toEqual({ requiresUser: true });
    expect(
      of(
        { matchedAskRule: { source: 'projectSettings', toolName: 'AskUserQuestion' } },
        'AskUserQuestion',
      ),
    ).toEqual({ askRule: true });
  });
});

describe('approvals: Claude Code’s choices, each mapped to exactly what the CLI is told', () => {
  it('offers Yes, always (every suggestion, worded whole), No and No with words, recorded', () => {
    const asked = request('suggestions-and-denials', 0);
    const { prompt, native } = prompted(raise(asked));
    expect(prompt).toEqual({
      kind: 'approval',
      title: 'Claude wants to access made.txt',
      summary: 'touch made.txt',
      subject: { type: 'tool', tool: 'Bash', input: asked.input },
      answerIn: 'api',
      choices: [
        {
          value: 'allow',
          label: 'Yes',
          hint: 'allow_once',
          effects: {},
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'always',
          label:
            "Yes, and don't ask again for `touch made.txt` in shop, and allow access to ~/shop during this session, and allow all edits during this session",
          hint: 'allow_always',
          effects: {
            rules: [{ behavior: 'allow', rule: 'Bash(touch made.txt)', scope: 'project' }],
            directories: ['/home/user/shop'],
            mode: 'acceptEdits',
          },
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'deny',
          label: 'No',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: true,
        },
        {
          value: 'deny-feedback',
          label: 'No, and tell Claude what to do differently',
          hint: 'reject_once',
          effects: {},
          feedback: 'required',
          endsTurn: false,
        },
      ],
    });
    // Always sends the request's own suggestions, all of them, verbatim.
    expect(permissionResult(native, choice('always'))).toEqual({
      behavior: 'allow',
      updatedInput: asked.input,
      updatedPermissions: asked.opts.suggestions,
      decisionClassification: 'user_permanent',
    });
    expect(permissionResult(native, choice('allow'))).toEqual({
      behavior: 'allow',
      updatedInput: asked.input,
      decisionClassification: 'user_temporary',
    });
  });

  it('denies with words as the recording did (the turn goes on), and No stops the turn', () => {
    const [, , , feedback, stop] = results('suggestions-and-denials');
    const { native } = prompted(raise(request('suggestions-and-denials', 3)));
    expect(
      permissionResult(
        native,
        choice('deny-feedback', { feedback: "Don't run it. Just say done." }),
      ),
    ).toEqual({ ...(feedback as object), decisionClassification: 'user_reject' });
    expect(DENIED_WITH_FEEDBACK).toBe(
      `${(feedback as { message: string }).message.split('\n')[0] ?? ''}\n`,
    );
    expect(permissionResult(native, choice('deny'))).toEqual({
      ...(stop as object),
      decisionClassification: 'user_reject',
    });
    expect((stop as { message: string }).message).toBe(DENIED);
  });

  it('words another party’s words as theirs, never the user’s', () => {
    const { native } = prompted(raise(request('suggestions-and-denials', 3)));
    const told = permissionResult(
      native,
      choice('deny-feedback', {
        feedback: 'Use the other folder',
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    );
    expect(told).toMatchObject({ behavior: 'deny' });
    const message = (told as { message: string }).message;
    expect(message).not.toMatch(/the user said/);
    expect(message).toMatch(/Lead.*not the user.*Use the other folder/s);
  });

  it('maps rule scopes by where the CLI keeps them', () => {
    const { prompt } = prompted(raise(request('suggestions-and-denials', 1)));
    if (prompt.kind !== 'approval') throw new Error('not an approval');
    expect(prompt.choices.find(({ value }) => value === 'always')).toMatchObject({
      label:
        "Yes, and don't ask again for `cat ../elsewhere/notes.txt` in shop, and don't ask again for Read(//home/user/elsewhere/**) during this session",
      effects: {
        rules: [
          { behavior: 'allow', rule: 'Bash(cat ../elsewhere/notes.txt)', scope: 'project' },
          { behavior: 'allow', rule: 'Read(//home/user/elsewhere/**)', scope: 'session' },
        ],
      },
    });
    const write = prompted(raise(request('suggestions-and-denials', 2))).prompt;
    if (write.kind !== 'approval') throw new Error('not an approval');
    expect(write.reason).toBe('Path is outside allowed working directories');
    expect(write.choices.find(({ value }) => value === 'always')?.effects).toEqual({
      directories: ['/home/user/elsewhere'],
      mode: 'acceptEdits',
    });
  });

  it('carries the ask rule and the safety check to the core as signals, and offers no always where none is suggested', () => {
    const rule = prompted(raise(request('ask-rule', 0))).prompt;
    expect(rule).toMatchObject({ signals: { askRule: true } });
    if (rule.kind !== 'approval') throw new Error('not an approval');
    expect(rule.choices.map(({ value }) => value)).toEqual(['allow', 'deny', 'deny-feedback']);
    const safety = prompted(raise(request('safety-check', 0))).prompt;
    expect(safety).toMatchObject({
      signals: { safetyCheck: true },
      reason:
        "Claude requested permissions to write to /home/user/shop/.claude/commands/hello.md, but you haven't granted it yet.",
    });
  });

  it('names an MCP server’s tool call by its server, and keeps its rule in the project', () => {
    const asked = request('mcp-elicitations', 0);
    const { prompt } = prompted(raise(asked));
    expect(prompt).toMatchObject({
      kind: 'approval',
      subject: {
        type: 'mcpTool',
        server: 'tracker',
        tool: 'mcp__tracker__file_issue',
        input: { title: 'Broken cart' },
      },
      signals: { requiresUser: true },
    });
    if (prompt.kind !== 'approval') throw new Error('not an approval');
    expect(prompt.choices.find(({ value }) => value === 'always')).toMatchObject({
      label: "Yes, and don't ask again for mcp__tracker__file_issue in shop",
      effects: {
        rules: [{ behavior: 'allow', rule: 'mcp__tracker__file_issue', scope: 'project' }],
      },
    });
  });

  it('never sends a suggestion its always doesn’t word (F6): a deny rule is worded too', () => {
    const asked = request('suggestions-and-denials', 0);
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      },
      {
        type: 'addRules',
        behavior: 'deny',
        destination: 'userSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
      },
    ];
    const { prompt, native } = prompted(raise({ ...asked, opts: { ...asked.opts, suggestions } }));
    if (prompt.kind !== 'approval') throw new Error('not an approval');
    const always = prompt.choices.find(({ value }) => value === 'always');
    expect(always?.label).toBe(
      "Yes, and don't ask again for `npm test` commands in shop, and always refuse `rm` commands anywhere",
    );
    expect(always?.effects).toEqual({
      rules: [
        { behavior: 'allow', rule: 'Bash(npm test:*)', scope: 'project' },
        { behavior: 'deny', rule: 'Bash(rm:*)', scope: 'user' },
      ],
    });
    expect(permissionResult(native, choice('always'))).toMatchObject({
      updatedPermissions: suggestions,
    });
  });

  it('offers a change it can word but not express with its effects unknown, and leaves out one it can’t word', () => {
    const asked = request('suggestions-and-denials', 0);
    const replace: PermissionUpdate[] = [
      {
        type: 'replaceRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }],
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
    ];
    const replaced = prompted(raise({ ...asked, opts: { ...asked.opts, suggestions: replace } }));
    if (replaced.prompt.kind !== 'approval') throw new Error('not an approval');
    const always = replaced.prompt.choices.find(({ value }) => value === 'always');
    expect(always).toBeDefined();
    expect(always).not.toHaveProperty('effects');
    expect(always?.label).toBe(
      'Yes, and replace the allow rules in shop’s shared settings with `npm` commands, and switch to Accept edits mode and keep it in shop',
    );
    expect(replaced.prompt).not.toHaveProperty('omitted');

    const strange = prompted(
      raise({
        ...asked,
        opts: {
          ...asked.opts,
          suggestions: [{ type: 'somethingNew', destination: 'session' }],
        },
      }),
    ).prompt;
    if (strange.kind !== 'approval') throw new Error('not an approval');
    expect(strange.choices.map(({ value }) => value)).toEqual(['allow', 'deny', 'deny-feedback']);
    expect(strange).toMatchObject({ omitted: true });
  });

  it('words rules and folders taken away too, leaving what they do unknown', () => {
    const asked = request('suggestions-and-denials', 0);
    const removing: PermissionUpdate[] = [
      {
        type: 'removeRules',
        behavior: 'deny',
        destination: 'userSettings',
        rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
      },
      { type: 'removeDirectories', directories: ['/home/user/docs'], destination: 'session' },
    ];
    const { prompt } = prompted(
      raise({ ...asked, opts: { ...asked.opts, suggestions: removing } }),
    );
    if (prompt.kind !== 'approval') throw new Error('not an approval');
    const always = prompt.choices.find(({ value }) => value === 'always');
    expect(always?.label).toBe(
      'Yes, and remove the deny rules for fetches from example.com anywhere, and stop allowing access to ~/docs during this session',
    );
    expect(always).not.toHaveProperty('effects');
  });

  it('offers no always where the CLI says it would allow too much', () => {
    const asked = request('suggestions-and-denials', 0);
    const { prompt } = prompted(
      raise({ ...asked, opts: { ...asked.opts, suppressAlwaysAllowRule: true } }),
    );
    if (prompt.kind !== 'approval') throw new Error('not an approval');
    expect(prompt.choices.map(({ value }) => value)).toEqual(['allow', 'deny', 'deny-feedback']);
    expect(prompt).not.toHaveProperty('omitted');
  });

  it('shows an edit’s diff in at most twelve lines, marked cut, and a big input as a marked preview', () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n');
    const big = toolPrompt(
      'Write',
      { file_path: '/home/user/shop/big.txt', content: content + 'x'.repeat(70_000) },
      { toolUseID: 't', requestId: 'r' } as unknown as ToolOptions,
      { places: RECORDED_PLACES, modes: MODES },
    );
    const { prompt } = prompted(big);
    expect(prompt.cut).toBe(true);
    expect(prompt.detail?.kind === 'diff' && prompt.detail.lines.length).toBe(12);
    expect(prompt.kind === 'approval' && prompt.subject).toMatchObject({
      type: 'tool',
      tool: 'Write',
      input: expect.stringMatching(/^\{"file_path":"\/home\/user\/shop\/big\.txt".*…$/s) as unknown,
    });
  });

  it('answers only an offered choice, and declines without stopping the turn', () => {
    const { native } = prompted(raise(request('suggestions-and-denials', 0)));
    expect(() => permissionResult(native, choice('maybe'))).toThrow(/not offered/);
    expect(() => permissionResult(native, { kind: 'questions', answers: {} })).toThrow();
    expect(declined(native, 'corrallm declined this request: too many wait.')).toEqual({
      behavior: 'deny',
      message: 'corrallm declined this request: too many wait.',
    });
  });
});

describe('questions (AskUserQuestion)', () => {
  it('asks the recorded question by an id of its own, and answers by its text, as the CLI took it', () => {
    const asked = request('question-and-plan', 0);
    const { prompt, native } = prompted(raise(asked));
    expect(prompt).toEqual({
      kind: 'question',
      title: 'Should the new file be named a.txt or b.txt?',
      answerIn: 'api',
      questions: [
        {
          id: 'q1',
          header: 'File name',
          text: 'Should the new file be named a.txt or b.txt?',
          options: [
            { label: 'a.txt', description: 'Create a.txt' },
            { label: 'b.txt', description: 'Create b.txt' },
          ],
          multiple: false,
          other: true,
        },
      ],
    });
    expect(
      permissionResult(native, {
        kind: 'questions',
        answers: { q1: { picked: ['a.txt'] } },
      }),
    ).toEqual(results('question-and-plan')[0]);
  });

  it('joins several picks as the CLI’s own UI does, and gives own words as they are', () => {
    const { native, prompt } = prompted(
      raise({
        tool: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which checks?',
              header: 'Checks',
              options: [
                { label: 'Lint', description: '' },
                { label: 'Tests, all', description: 'Every project', preview: 'vitest run' },
              ],
              multiSelect: true,
            },
            {
              question: 'Where?',
              header: 'Where',
              options: [
                { label: 'Here', description: '' },
                { label: 'There', description: '' },
              ],
              multiSelect: false,
            },
          ],
        },
        opts: { toolUseID: 't', requestId: 'r', requiresUserInteraction: true },
      }),
    );
    expect(prompt).toMatchObject({ title: 'Claude asks 2 questions' });
    expect(prompt.kind === 'question' && prompt.questions[0]?.options[1]).toEqual({
      label: 'Tests, all',
      description: 'Every project',
      preview: 'vitest run',
    });
    expect(prompt).not.toHaveProperty('signals');
    expect(
      permissionResult(native, {
        kind: 'questions',
        answers: { q1: { picked: ['Lint', 'Tests, all'] }, q2: { text: 'Somewhere else' } },
      }),
    ).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { 'Which checks?': 'Lint, Tests, all', 'Where?': 'Somewhere else' },
      },
    });
  });

  it('declines questions it can’t key faithfully, saying so', () => {
    const twice = raise({
      tool: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Same?', header: 'A', options: [{ label: 'x' }, { label: 'y' }] },
          { question: 'Same?', header: 'B', options: [{ label: 'x' }, { label: 'y' }] },
        ],
      },
      opts: { toolUseID: 't', requestId: 'r' },
    });
    expect(twice).toEqual({ declined: expect.stringMatching(/two questions the same/) as unknown });
  });

  it('is an approval, not a question, when an MCP server’s tool claims the name', () => {
    const { prompt } = prompted(
      raise({
        tool: 'AskUserQuestion',
        input: { questions: [] },
        opts: { toolUseID: 't', requestId: 'r', mcpServer: { name: 'evil', source: 'project' } },
      }),
    );
    expect(prompt.kind).toBe('approval');
  });
});

describe('plans (ExitPlanMode)', () => {
  it('offers the modes to carry it out in, each allowed with a session mode, as recorded', () => {
    const asked = request('plan-into-mode', 0);
    const { prompt, native } = prompted(raise(asked));
    expect(prompt).toMatchObject({ kind: 'plan', plan: asked.input.plan, answerIn: 'api' });
    if (prompt.kind !== 'plan') throw new Error('not a plan');
    expect(prompt.choices).toEqual([
      {
        value: 'auto',
        label: 'Yes, and use auto mode',
        hint: 'allow_once',
        effects: { mode: 'auto' },
        feedback: 'none',
        endsTurn: false,
      },
      {
        value: 'acceptEdits',
        label: 'Yes, and auto-accept edits',
        hint: 'allow_once',
        effects: { mode: 'acceptEdits' },
        feedback: 'none',
        endsTurn: false,
      },
      {
        value: 'manual',
        label: 'Yes, and manually approve edits',
        hint: 'allow_once',
        effects: { mode: 'manual' },
        feedback: 'none',
        endsTurn: false,
      },
      {
        value: 'keep-planning',
        label: 'No, keep planning',
        hint: 'reject_once',
        effects: {},
        feedback: 'optional',
        endsTurn: false,
      },
    ]);
    // Exactly what the CLI took, recorded: it went into Accept edits at once.
    expect(permissionResult(native, choice('acceptEdits'))).toEqual(results('plan-into-mode')[0]);
    expect(permissionResult(native, choice('manual'))).toMatchObject({
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    });
    expect(
      permissionResult(native, choice('keep-planning', { feedback: 'Name it c.txt' })),
    ).toEqual({
      behavior: 'deny',
      message: 'The user wants you to keep planning. Their feedback: Name it c.txt',
    });
  });

  it('offers auto only where the session lists it', () => {
    const { prompt } = prompted(
      raise(request('plan-into-mode', 0), ['manual', 'acceptEdits', 'plan']),
    );
    expect(prompt.kind === 'plan' && prompt.choices.map(({ value }) => value)).toEqual([
      'acceptEdits',
      'manual',
      'keep-planning',
    ]);
  });
});

describe('MCP servers’ requests (elicitations)', () => {
  const [form, link] = elicitations('mcp-elicitations');
  const elicit = (recordedRequest: RecordedElicitation | undefined) =>
    elicitationPrompt(recordedRequest?.request as unknown as ElicitationRequest);

  it('asks the recorded form, in the schema the core re-serialized, naming its server', () => {
    const raised = elicit(form);
    const { prompt, native } = prompted(raised);
    expect(prompt).toEqual({
      kind: 'form',
      title: 'Which repository should the issue go in?',
      server: 'tracker',
      answerIn: 'api',
      form: {
        schema: {
          type: 'object',
          properties: {
            repo: { type: 'string', title: 'Repository', minLength: 1 },
            priority: {
              type: 'string',
              title: 'Priority',
              enum: ['low', 'high'],
              enumNames: ['Low', 'High'],
            },
            draft: { type: 'boolean', title: 'Draft', default: false },
          },
          required: ['repo'],
          additionalProperties: false,
        },
      },
    });
    const answer: PromptAnswer = {
      kind: 'form',
      action: 'accept',
      values: { repo: 'acme/shop', priority: 'high', draft: false },
    };
    // The core's check and the adapter's agree, and the CLI is told what was recorded.
    expect(checkPromptAnswer(prompt, answer)).toEqual(answer);
    expect(elicitationResult(native, answer)).toEqual(
      recorded('mcp-elicitations').find((item) => item.kind === 'elicitationResult')?.data,
    );
    expect(() =>
      elicitationResult(native, { kind: 'form', action: 'accept', values: { priority: 'high' } }),
    ).toThrow(/Repository is required/);
    expect(elicitationResult(native, { kind: 'form', action: 'decline' })).toEqual({
      action: 'decline',
    });
  });

  it('asks to open the recorded link, the link only in the form, never in its words', () => {
    const { prompt, native } = prompted(elicit(link));
    expect(prompt).toEqual({
      kind: 'form',
      title: 'Sign in to the tracker to continue.',
      server: 'tracker',
      answerIn: 'api',
      form: { url: 'https://tracker.example.com/sign-in?state=abc123' },
    });
    expect(elicitationResult(native, { kind: 'form', action: 'accept' })).toEqual({
      action: 'accept',
    });
    const quoting = prompted(
      elicitationPrompt({
        serverName: 'tracker',
        mode: 'url',
        url: 'https://tracker.example.com/x?token=s3cret',
        message: 'Open https://tracker.example.com/x?token=s3cret to sign in',
      }),
    ).prompt;
    expect(JSON.stringify({ ...quoting, form: undefined })).not.toMatch(/s3cret/);
    expect(quoting.title).toBe('Open the link to sign in');
  });

  it('declines a form it can’t show, naming its server; and a link that isn’t one', () => {
    expect(
      elicitationPrompt({
        serverName: 'github',
        mode: 'form',
        message: 'Which?',
        requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
      }),
    ).toEqual({
      declined: 'github asked for something corrallm can’t show, so it was declined: Which?',
    });
    expect(elicitationPrompt({ serverName: 'github', mode: 'url', message: 'Go' })).toEqual({
      declined: expect.stringMatching(/^github asked/) as unknown,
    });
    const { native } = prompted(elicit(form));
    expect(declined(native, 'no')).toEqual({ action: 'decline' });
  });
});
