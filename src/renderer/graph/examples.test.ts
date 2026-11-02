import { compileExample } from '../../shared/model/test-template';
import { readTemplate } from '../../shared/model/template-file';
import { describe, expect, it } from 'vitest';

import { catalog } from '../catalog';
import { actionsOf } from './agents';
import { EXAMPLES } from '../../shared/examples';
import { fromFile, toFile } from '../../shared/model/file';
import { placeholdersOf } from '../../shared/model/templates';
import {
  findItem,
  isApproval,
  isDelay,
  isIf,
  isRepeat,
  isRepeatEnds,
  isWait,
} from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import { workEdges } from '../../shared/model/work';
import { documentOf, graphOf } from '../test-graph-data';

describe.each(EXAMPLES)('the $name example', (example) => {
  const graph = graphOf(compileExample(example, catalog(), 'claude-code'));
  const agents = new Map(graph.nodes.filter((n) => n.type === 'agent').map((n) => [n.id, n]));

  it('writes a compiled template as a canonical runtime canvas with explicit endpoints', () => {
    const document = documentOf(graph, readTemplate(example.text).id);
    const file = toFile(document);
    expect(fromFile(file, catalog())).toEqual(document);
    expect(toFile(fromFile(file, catalog()))).toBe(file);
    for (const agent of agents.values())
      expect(agent.data).toMatchObject({
        adapter: 'claude-code',
        connection: 'claude-code.terminal',
      });
  });

  it("aims only at its own agents, and uses only each agent's own actions", () => {
    for (const agent of agents.values()) {
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
          if ('action' in item)
            expect(
              actionsOf(agents.get(item.target ?? agent.id)?.data.adapter).map(
                (action) => action.name,
              ),
            ).toContain(item.action);
        }
      };
      (agent.data.queue ?? []).forEach(check);
    }
  });

  it('says what every shipped job step is to do after compilation', () => {
    const vague = (item: QueueItem): string[] => {
      if (isIf(item)) return item.then.flatMap(vague);
      if (isRepeat(item)) return item.repeat.flatMap(vague);
      if (!('action' in item) || (item.instruction ?? '').trim() !== '') return [];
      return [item.action];
    };
    expect(
      [...agents.values()].flatMap((agent) => (agent.data.queue ?? []).flatMap(vague)),
    ).toEqual([]);
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

describe('the examples', () => {
  it('each have an id of their own', () => {
    const ids = EXAMPLES.map((example) => readTemplate(example.text).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
