import { AgentId } from './api/ids';
import { Prompt, PromptId } from './model/prompts';
import type { AdapterPrompt, PromptEvent } from './model/prompts';
import type { OpenPromptEntry } from './model/session';

/** Owner-protocol fixtures, with an independent occurrence id for each raise. */
export function testPromptEntry(
  prompt: AdapterPrompt,
  agent = 'a',
  id: string = crypto.randomUUID(),
): OpenPromptEntry {
  const shown = { ...prompt };
  delete shown.signals;
  delete shown.omitted;
  return {
    id,
    kind: 'prompt',
    need: `prompt/${encodeURIComponent(agent)}/1/${id}`,
    name: agent,
    prompt: Prompt.parse({
      ...shown,
      id: PromptId.parse(id),
      agent: AgentId.parse(agent),
      raised: 1,
      ...('choices' in shown ? { choices: shown.choices.map((choice) => ({ ...choice })) } : {}),
    }),
  };
}
export function testPromptEvent(
  prompt: AdapterPrompt,
  key: string = crypto.randomUUID(),
): PromptEvent {
  return { type: 'prompt', key, prompt };
}
export function testApproval(
  title = 'Run this command?',
): Extract<AdapterPrompt, { kind: 'approval' }> {
  return {
    kind: 'approval',
    title,
    summary: 'npm test',
    subject: { type: 'tool', tool: 'Bash', input: { command: 'npm test' } },
    answerIn: 'api',
    signals: { requiresUser: true },
    choices: [
      { value: 'once', label: 'Yes', hint: 'allow_once', effects: {} },
      { value: 'always', label: 'Always allow npm test', hint: 'allow_always', effects: {} },
      { value: 'deny', label: 'No', hint: 'reject_once', effects: {}, feedback: 'optional' },
    ],
  };
}
export function testQuestions(): Extract<AdapterPrompt, { kind: 'question' }> {
  return {
    kind: 'question',
    title: 'Which branch?',
    answerIn: 'api',
    signals: { requiresUser: true },
    questions: [
      {
        id: 'branch',
        header: 'Branch',
        text: 'Which branch?',
        options: [{ label: 'main', description: 'The main branch' }],
        multiple: false,
        other: true,
      },
    ],
  };
}

/** Stable opaque keys for fixtures which refer to the same occurrence more than once. */
export function testPromptId(label: string): string {
  let code = 2166136261;
  for (const ch of label) code = Math.imul(code ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `00000000-0000-4000-8000-${code.toString(16).padStart(12, '0')}`;
}
