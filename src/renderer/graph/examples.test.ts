import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS, DEFAULT_AGENT } from './agents';
import { EXAMPLES } from './examples';
import { fromFile, toFile } from './file';
import { isIf } from './queue';
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
        const steps = isIf(item) ? item.then : [item];
        if (isIf(item) && item.if.kind === 'nodeDone') expect(agents.has(item.if.node)).toBe(true);
        for (const step of steps) {
          if (step.target !== undefined) expect(agents.has(step.target)).toBe(true);
          if ('action' in step) expect(actions).toContain(step.action);
        }
      }
    }
  });

  it('shows work passing between its agents', () => {
    expect(workEdges(graph.nodes).length).toBeGreaterThan(0);
  });
});
