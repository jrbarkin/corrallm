import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS, AgentType } from '../graph/agents';
import type { Step } from './player';
import { scriptedTurn } from './script';
import type { Mode } from './session';

/** Every step a turn can take, whichever way its permission prompts are answered. */
function everyStep(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) =>
    step.kind === 'ask' ? [step, ...everyStep(step.allow), ...everyStep(step.deny)] : [step],
  );
}

const ids = () => {
  let n = 0;
  return () => `id${String(++n)}`;
};

/** The tools a turn asks permission for. */
const asks = (steps: readonly Step[]) =>
  everyStep(steps).flatMap((step) => (step.kind === 'ask' ? [step.entry.tool] : []));

describe('scriptedTurn', () => {
  it.each(Object.values(AgentType))(
    'thinks, reads, plans and edits with %s’s own tools',
    (agent) => {
      const steps = everyStep(scriptedTurn('Add rate limiting', agent, 'manual', ids()));
      const actions = AGENT_ACTIONS[agent].map((a) => a.name);
      for (const step of steps) {
        if (step.kind === 'add' && step.entry.kind === 'tool') {
          expect(actions).toContain(step.entry.tool);
        }
      }
      const kinds = new Set(
        steps.flatMap((step) => (step.kind === 'add' ? [step.entry.kind] : [])),
      );
      expect([...kinds].sort()).toEqual(['thinking', 'todos', 'tool']);
    },
  );

  it.each<[Mode, string[]]>([
    ['manual', ['Edit', 'Bash']],
    ['acceptEdits', ['Bash']],
    ['auto', []],
    ['bypassPermissions', []],
    ['plan', []],
  ])('asks permission as the %s mode says', (mode, tools) => {
    expect(asks(scriptedTurn('Go', AgentType.Claude, mode, ids()))).toEqual(tools);
  });

  it('only reads and plans in plan mode', () => {
    const steps = everyStep(scriptedTurn('Go', AgentType.Claude, 'plan', ids()));
    const tools = steps.flatMap((step) =>
      step.kind === 'add' && step.entry.kind === 'tool' ? [step.entry.tool] : [],
    );
    expect(tools).toEqual(['Read', 'Grep']);
  });

  it('says it is scripted, and gives each entry its own id', () => {
    const steps = everyStep(scriptedTurn('Hi', AgentType.Claude, 'manual', ids()));
    const texts = steps.flatMap((step) => (step.kind === 'stream' ? [step.text] : []));
    expect(texts.join(' ')).toMatch(/scripted/);
    const added = steps.flatMap((step) =>
      step.kind === 'add' ? [step.entry.id] : step.kind === 'stream' ? [step.id] : [],
    );
    expect(new Set(added).size).toBe(added.length);
  });
});
