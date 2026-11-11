import type { AdapterPrompt } from '../../../shared/model/prompts';

/** What makes two prompts the same ask, whoever tells it and wherever it is answered. */
export function askOf(prompt: AdapterPrompt): string {
  return JSON.stringify([
    prompt.kind,
    prompt.title,
    prompt.kind === 'approval' ? prompt.subject : undefined,
    // What the questions say, not how their options are drawn (a hook's telling and a held card
    // differ in previews and cuts).
    prompt.kind === 'question' ? prompt.questions.map(({ text }) => text) : undefined,
    prompt.kind === 'plan' ? prompt.plan : undefined,
  ]);
}
