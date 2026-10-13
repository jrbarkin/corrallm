import type { AgentAction } from '../graph/agents';

/*
 * What the queues' run says to a connected agent, as messages to its session, and how it reads
 * what the agent says back: a step's instruction, a condition's yes-or-no question, whether the
 * answer is yes, and whether a reply contains what an If looks for.
 */

/**
 * What a step asks of a connected agent: a slash command is sent as that command, with what the
 * step is to do (`instruction`, the user's words) as its arguments; a tool, as a short instruction
 * to use it for the step, then what the step is to do ("Use the Bash tool for this step: run npm
 * test"), or else what the tool does (`actions`: its agent type's, from agents.ts), and whose work
 * it acts on when that is another agent's (`other`, its name).
 */
export function stepMessage(
  action: string,
  actions: readonly AgentAction[],
  other?: string,
  instruction?: string,
): string {
  const told = instruction?.trim() ?? '';
  if (action.startsWith('/')) return told === '' ? action : `${action} ${told}`;
  const on = other === undefined ? '' : `, on the work of ${other} (another agent)`;
  if (told !== '') return `Use the ${action} tool for this step${on}: ${told}`;
  const what = actions.find((a) => a.name === action)?.description;
  const does = what === undefined ? '' : ` (${what.charAt(0).toLowerCase()}${what.slice(1)})`;
  return `Use the ${action} tool for this step${does}${on}.`;
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
