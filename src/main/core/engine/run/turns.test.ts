import { describe, expect, it } from 'vitest';

import { conditionQuestion, replyContains, stepMessage, stepVerdict, yesOrNo } from './turns';
import { TEST_ENGINE } from '../test-engine';

describe('what the run says to a connected agent', () => {
  const claude = TEST_ENGINE.actionsOf({ adapter: 'claude-code' });
  /** What a tool's step asks for at its end: how it went. */
  const VERDICT =
    ' End your reply with SUCCEEDED or FAILED on a line of its own: whether the step succeeded (a command: whether it exited with status 0; tests: whether they all passed), even if you expected it to fail.';

  it('sends a slash command as that command, and a tool as an instruction to use it', () => {
    expect(stepMessage('/code-review', claude)).toBe('/code-review');
    expect(stepMessage('/compact', claude, 'Builder')).toBe('/compact');
    expect(stepMessage('Bash', claude)).toBe(
      `Use the Bash tool for this step (run shell commands).${VERDICT}`,
    );
    expect(stepMessage('EnterWorktree', claude)).toBe(
      `Use the EnterWorktree tool for this step (work in an isolated git worktree).${VERDICT}`,
    );
    // Aimed at another agent: whose work it acts on.
    expect(stepMessage('Read', claude, 'Builder')).toBe(
      `Use the Read tool for this step (read files), on the work of Builder (another agent).${VERDICT}`,
    );
    // An action its type does not have (left from another type): named as it is.
    expect(stepMessage('exec_command', claude)).toBe(
      `Use the exec_command tool for this step.${VERDICT}`,
    );
  });

  it('reads how a step went from the last line of its reply: SUCCEEDED or FAILED', () => {
    expect(stepVerdict('Ran `node --test`: 12 pass.\n\nSUCCEEDED')).toBe(true);
    expect(stepVerdict('All 12 fail, as expected: wc.js is missing.\n\nFAILED')).toBe(false);
    expect(stepVerdict('Done.\r\n FAILED \r\n')).toBe(false);
    expect(stepVerdict('Done.\nSUCCEEDED\n')).toBe(true);
    // Not on the last line, in other words, or both: no verdict.
    expect(stepVerdict('FAILED at first.\nThen it passed.')).toBeUndefined();
    expect(stepVerdict('2 tests failed.')).toBeUndefined();
    expect(stepVerdict('**FAILED**')).toBeUndefined();
    expect(stepVerdict('Result: FAILED')).toBeUndefined();
    expect(stepVerdict('SUCCEEDED or FAILED?')).toBeUndefined();
    expect(stepVerdict('')).toBeUndefined();
  });

  it('says what a step is to do, in the user’s words: after a tool, or as a command’s arguments', () => {
    // The user's words as they are, then how the step went asked for in a paragraph of its own.
    expect(stepMessage('Bash', claude, undefined, 'run npm test')).toBe(
      `Use the Bash tool for this step: run npm test\n\n${VERDICT.trim()}`,
    );
    expect(stepMessage('Read', claude, 'Builder', ' its notes in NOTES.md ')).toBe(
      `Use the Read tool for this step, on the work of Builder (another agent): its notes in NOTES.md\n\n${VERDICT.trim()}`,
    );
    expect(stepMessage('Bash', claude, undefined, 'Run the tests:\n- unit\n- e2e')).toBe(
      `Use the Bash tool for this step: Run the tests:\n- unit\n- e2e\n\n${VERDICT.trim()}`,
    );
    // A slash command takes them as its arguments, with nothing asked of it.
    expect(stepMessage('/code-review', claude, undefined, 'src/cart.ts')).toBe(
      '/code-review src/cart.ts',
    );
    // Blank: as if there were none.
    expect(stepMessage('Bash', claude, undefined, '  ')).toBe(
      `Use the Bash tool for this step (run shell commands).${VERDICT}`,
    );
  });

  it('asks a Codex agent how its step went too, but not of its slash commands', () => {
    const codex = TEST_ENGINE.actionsOf({ adapter: 'codex' });
    expect(stepMessage('exec_command', codex)).toBe(
      `Use the exec_command tool for this step (run a shell command).${VERDICT}`,
    );
    expect(stepMessage('exec_command', codex, undefined, 'npm test')).toBe(
      `Use the exec_command tool for this step: npm test\n\n${VERDICT.trim()}`,
    );
    expect(stepMessage('/review', codex, undefined, 'the cart')).toBe('/review the cart');
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

  it('matches whole lines when requested, excluding rejection and mentions of the verdict', () => {
    expect(replyContains('NOT APPROVED', 'APPROVED', true)).toBe(false);
    expect(replyContains('Verdict: APPROVED', 'APPROVED', true)).toBe(false);
    expect(replyContains('APPROVED: once the tests pass', 'APPROVED', true)).toBe(false);
    expect(replyContains('APPROVED', 'APPROVED', true)).toBe(true);
    expect(replyContains('No issues.\r\n APPROVED \r\n', 'APPROVED', true)).toBe(true);
    expect(replyContains('not approved', 'APPROVED', true)).toBe(false);
    expect(replyContains('', 'APPROVED', true)).toBe(false);
    // Existing substring conditions keep their meaning.
    expect(replyContains('Verdict: APPROVED', 'APPROVED')).toBe(true);
  });
});
