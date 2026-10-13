import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS, DEFAULT_AGENT } from './agents';
import { EXAMPLES } from './examples';
import { fromFile, toFile } from './file';
import { placeholdersOf } from './templates';
import { isApproval, isDelay, isIf, isWait } from './queue';
import { workEdges } from './work';

describe.each(EXAMPLES)('the $name example', (example) => {
  const graph = fromFile(example.text);
  const agents = new Map(graph.nodes.filter((n) => n.type === 'agent').map((n) => [n.id, n]));

  it('is a canvas, written just as corrallm writes one', () => {
    expect(toFile(graph)).toBe(example.text);
  });

  it("aims only at its own agents, and uses only each agent's own actions", () => {
    for (const agent of agents.values()) {
      const actions = AGENT_ACTIONS[agent.data.agent ?? DEFAULT_AGENT].map((a) => a.name);
      for (const item of agent.data.queue ?? []) {
        if (isWait(item)) {
          for (const { agent: waited, item: step } of item.waitFor) {
            const queue = agents.get(waited)?.data.queue ?? [];
            expect(agents.has(waited)).toBe(true);
            if (step !== undefined) expect(queue.map((q) => q.id)).toContain(step);
          }
          continue;
        }
        if (isDelay(item) || isApproval(item)) continue;
        const steps = isIf(item) ? item.then : [item];
        for (const step of steps) {
          if (step.target !== undefined) expect(agents.has(step.target)).toBe(true);
          if ('action' in step) expect(actions).toContain(step.action);
        }
      }
    }
  });

  it('asks for each of its blanks, and has no field it does not use', () => {
    expect(placeholdersOf(graph).sort()).toEqual((example.fields ?? []).map((f) => f.key).sort());
  });

  it('holds for your OK where it says you approve something', () => {
    const oks = [...agents.values()].flatMap((agent) =>
      (agent.data.queue ?? []).filter(isApproval),
    );
    expect(oks.length > 0).toBe(/\byou approve\b/.test(example.description));
  });

  it('shows work passing between its agents', () => {
    expect(workEdges(graph.nodes).length).toBeGreaterThan(0);
  });
});
