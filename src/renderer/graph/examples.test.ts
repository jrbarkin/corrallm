import { describe, expect, it } from 'vitest';

import { AGENT_ACTIONS, DEFAULT_AGENT } from './agents';
import { EXAMPLES } from './examples';
import { fromFile, toFile } from './file';
import { placeholdersOf } from './templates';
import { findItem, isApproval, isDelay, isIf, isRepeat, isRepeatEnds, isWait } from './queue';
import type { QueueItem } from './queue';
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
      // Every level of nesting: what if-thens and repeats hold too.
      const check = (item: QueueItem) => {
        if (isWait(item)) {
          for (const { agent: waited, item: step } of item.waitFor) {
            expect(agents.has(waited)).toBe(true);
            if (step !== undefined)
              expect(findItem(agents.get(waited)?.data.queue ?? [], step)).toBeDefined();
          }
        } else if (isIf(item)) {
          item.then.forEach(check);
        } else if (isRepeat(item)) {
          // A repeat that goes round with another: one of another agent's repeats.
          if (isRepeatEnds(item.until)) {
            const { agent: leader, item: id } = item.until;
            expect(leader).not.toBe(agent.id);
            const found = agents.get(leader)?.data.queue?.find((q) => q.id === id);
            expect(found && isRepeat(found)).toBe(true);
          }
          item.repeat.forEach(check);
        } else if (!isDelay(item) && !isApproval(item)) {
          if (item.target !== undefined) expect(agents.has(item.target)).toBe(true);
          if ('action' in item) expect(actions).toContain(item.action);
        }
      };
      (agent.data.queue ?? []).forEach(check);
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
