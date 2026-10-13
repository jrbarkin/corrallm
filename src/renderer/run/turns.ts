import type { AgentAction } from '../graph/agents';

/*
 * What the queues' run says to a connected agent, as messages to its session, and how it reads
 * what the agent says back: a step's instruction and how the step went, a condition's yes-or-no
 * question, whether the answer is yes, and whether a reply contains what an If looks for.
 */

/** Whether a step's action is a slash command (sent as it is), rather than a tool. */
export function isCommand(action: string): boolean {
  return action.startsWith('/');
}

/**
 * What a step asks of a connected agent: a slash command is sent as that command; a tool, as a
 * short instruction to use it for the step, with what it does (`actions`: its agent type's, from
 * agents.ts), and whose work it acts on when that is another agent's (`other`, its name), then to
 * say how the step went (read by stepVerdict): whether it succeeded, not whether it went as
 * expected, so that tests written to fail first still fail it.
 */
export function stepMessage(
  action: string,
  actions: readonly AgentAction[],
  other?: string,
): string {
  if (isCommand(action)) return action;
  const what = actions.find((a) => a.name === action)?.description;
  const does = what === undefined ? '' : ` (${what.charAt(0).toLowerCase()}${what.slice(1)})`;
  const on = other === undefined ? '' : `, on the work of ${other} (another agent)`;
  return (
    `Use the ${action} tool for this step${does}${on}. End your reply with SUCCEEDED or FAILED on ` +
    'a line of its own: whether the step succeeded (a command: whether it exited with status 0; ' +
    'tests: whether they all passed), even if you expected it to fail.'
  );
}

/**
 * How a connected agent said its step went: true for SUCCEEDED, false for FAILED, undefined if the
 * last line of its reply says neither (or both). In capitals, as asked, so that a last line such
 * as "2 tests failed." is not taken for a verdict.
 */
export function stepVerdict(reply: string): boolean | undefined {
  const last = reply.trim().split('\n').at(-1) ?? '';
  const succeeded = /\bSUCCEEDED\b/.test(last);
  const failed = /\bFAILED\b/.test(last);
  return succeeded === failed ? undefined : succeeded;
}

/**
 * The question asked in a connected agent's session about a condition in the user's own words:
 * whether it holds now, answered yes or no. It says it is corrallm's, wherever it shows (the
 * transcript, or Claude Code's own terminal).
 */
export function conditionQuestion(condition: string): string {
  return `corrallm asks: is this true now? “${condition.trim()}” Start your answer with yes or no.`;
}

/**
 * How an agent answered a yes-or-no question: true for yes, false for no, undefined if neither.
 * Read from the first word of its reply, or of its reply's last paragraph (it may look into
 * things first, then answer).
 */
export function yesOrNo(reply: string): boolean | undefined {
  const last =
    reply
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ?? '';
  for (const text of [reply, last]) {
    const word = /^[^\p{L}]*(\p{L}+)/u.exec(text)?.[1]?.toLowerCase();
    if (word === 'yes') return true;
    if (word === 'no') return false;
  }
  return undefined;
}

/**
 * Whether a reply contains the text an If looks for, exactly as written: its case too, so that a
 * marker such as "APPROVED" is not found in "not approved".
 */
export function replyContains(reply: string, text: string): boolean {
  return reply.includes(text);
}
