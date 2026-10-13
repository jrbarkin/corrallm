import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS } from '../graph/agents';
import { conditionQuestion, replyContains, stepMessage, yesOrNo } from './turns';

describe('what the run says to a connected agent', () => {
  const claude = AGENT_ACTIONS.Claude;

  it('sends a slash command as that command, and a tool as an instruction to use it', () => {
    expect(stepMessage('/code-review', claude)).toBe('/code-review');
    expect(stepMessage('/compact', claude, 'Builder')).toBe('/compact');
    expect(stepMessage('Bash', claude)).toBe(
      'Use the Bash tool for this step (run shell commands).',
    );
    expect(stepMessage('EnterWorktree', claude)).toBe(
      'Use the EnterWorktree tool for this step (work in an isolated git worktree).',
    );
    // Aimed at another agent: whose work it acts on.
    expect(stepMessage('Read', claude, 'Builder')).toBe(
      'Use the Read tool for this step (read files), on the work of Builder (another agent).',
    );
    // An action its type does not have (left from another type): named as it is.
    expect(stepMessage('exec_command', claude)).toBe('Use the exec_command tool for this step.');
  });

  it('asks a plain yes-or-no question about a condition in the user’s words', () => {
    expect(conditionQuestion('  the tests pass ')).toBe(
      'corrallm asks: is this true now? “the tests pass” Start your answer with yes or no.',
    );
  });

  it('reads yes or no from the start of the answer, or of its last paragraph', () => {
    expect(yesOrNo('Yes, all 12 pass.')).toBe(true);
    expect(yesOrNo('**No** — two fail.')).toBe(false);
    expect(yesOrNo('no.')).toBe(false);
    expect(yesOrNo('Let me run them first.\n\nYES: they pass.')).toBe(true);
    expect(yesOrNo('Let me check.\n\nNo, `auth.test.ts` fails.')).toBe(false);
    // Neither: unclear.
    expect(yesOrNo('Mostly: the API page is missing.')).toBeUndefined();
    expect(yesOrNo('Yesterday they passed.')).toBeUndefined();
    expect(yesOrNo('Nothing changed.')).toBeUndefined();
    expect(yesOrNo('')).toBeUndefined();
  });

  it('finds what an If looks for in a reply exactly as written, case and all', () => {
    expect(replyContains('Ran 12 tests: 0 failed.', '0 failed')).toBe(true);
    expect(replyContains('Verdict: APPROVED', 'APPROVED')).toBe(true);
    expect(replyContains('Not approved yet.', 'APPROVED')).toBe(false);
    expect(replyContains('', 'APPROVED')).toBe(false);
  });
});
