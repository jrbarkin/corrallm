import { afterEach, describe, expect, it } from 'vitest';

import { fromFile } from '../../shared/model/file';
import { expectRestorable } from '../../shared/engine/run/test-restore';
import { manual, setup } from '../../shared/engine/run/test-run';
import { catalog } from '../catalog';
import { connectionsOf, DEFAULT_AGENT } from './agents';
import { EXAMPLES } from '../../shared/examples';
import { canvasNodes, graphOf } from '../test-graph-data';
import { fillTemplate } from '../../shared/model/templates';

/*
 * The built-in templates, run: each runs as its author meant, with what its blanks are filled
 * with in its form, its agents connected their adapters' first way.
 */

afterEach(expectRestorable);

const exampleNodes = (name: string) => {
  const example = EXAMPLES.find((e) => e.name === name);
  const values = Object.fromEntries((example?.fields ?? []).map((f) => [f.key, f.example]));
  return canvasNodes(
    fillTemplate(
      graphOf(fromFile(example?.text ?? '', catalog(), DEFAULT_AGENT)),
      values,
    ).nodes.map((node) => {
      const connection = connectionsOf(node.data.adapter ?? DEFAULT_AGENT)[0];
      return node.type === 'agent' && connection
        ? { ...node, data: { ...node.data, connection } }
        : node;
    }),
  );
};

describe('the built-in templates, run', () => {
  it.each([
    ['tests', 'Ran the suite: 10 failed', false],
    ['tests', 'Ran the suite.\n0 failed\nSUCCEEDED', true],
    ['fixer', 'Ran the suite: 10 failed', false],
    ['fixer', 'Ran the full suite.\n0 failed', true],
  ] as const)(
    'Release checks requires a zero-failure line from %s: %s',
    (source, output, releases) => {
      const { store, reply, where, sent } = setup(exampleNodes('Release checks'), manual);
      store.start();
      reply('releaser');
      if (source === 'tests') {
        reply('releaser', false, output);
        // Resolve the missing tool verdict so the condition reads this reply.
        if (!releases) store.decide('releaser', 'tests', { choice: 'resolve' });
      } else {
        reply('releaser', false, 'Ran the suite: 10 failed\nFAILED');
        store.decide('releaser', 'tests', { choice: 'continue' });
        expect(where().releaser).toBe('running fix');
        reply('fixer', false, output);
      }
      expect(where().releaser).toBe(releases ? 'running audit' : 'done');
      if (releases) {
        reply('releaser');
        expect(where().releaser).toBe('running tag');
        reply('releaser');
      }
      expect(sent.filter((turn) => turn.agent === 'releaser')).toHaveLength(releases ? 4 : 2);
      expect(store.snapshot().agents.releaser?.outcomes.green).toBe(
        releases ? 'succeeded' : 'skipped',
      );
    },
  );

  it.each([
    ['No clear WINNER yet.', false],
    ['Version A wins.\r\nWINNER\r\n', true],
  ] as const)('Head to head ends the repeat only on a WINNER line: %s', (output, ends) => {
    const { store, reply, where, sent } = setup(exampleNodes('Head to head'), manual);
    store.start();
    reply('claude', false, 'SUCCEEDED');
    reply('codex');
    reply('claude');
    reply('codex');
    reply('judge', false, output);
    expect(store.snapshot().agents.judge?.rounds).toEqual({
      judging: { round: ends ? 1 : 2 },
    });
    expect(where().judge).toBe(ends ? 'running merge' : 'waiting built');
    expect(sent.filter((turn) => turn.agent === 'judge')).toHaveLength(ends ? 2 : 1);
  });

  it('Fan-out research sends each search only after its question turn ends', () => {
    const { store, reply, sent } = setup(exampleNodes('Fan-out research'), manual);
    store.start();
    for (const researcher of ['r1', 'r2', 'r3']) {
      expect(sent.filter((turn) => turn.agent === researcher)).toHaveLength(1);
      reply(researcher);
      expect(sent.filter((turn) => turn.agent === researcher)).toHaveLength(2);
      expect(store.snapshot().agents[researcher]?.current).toBe('search');
    }
  });

  it('Fan-out research sends the Writer its task only after all three report turns end', () => {
    const { store, reply, sent } = setup(exampleNodes('Fan-out research'), manual);
    const writerTurns = () => sent.filter((turn) => turn.agent === 'writer');
    store.start();
    expect(writerTurns()).toHaveLength(0);
    for (const researcher of ['r1', 'r2', 'r3']) reply(researcher);
    for (const [index, researcher] of ['r1', 'r2', 'r3'].entries()) {
      reply(researcher, false, 'Found sources.\nSUCCEEDED');
      expect(writerTurns()).toHaveLength(index + 1);
      reply('writer');
      expect(writerTurns()).toHaveLength(index === 2 ? 4 : index + 1);
    }
    expect(store.snapshot().agents.writer?.current).toBe('write');
  });

  it.each(['TDD relay', 'Spec first'])(
    'checks the %s template’s new tests fail before anything is built',
    (name) => {
      const example = EXAMPLES.find((e) => e.name === name);
      const values = Object.fromEntries((example?.fields ?? []).map((f) => [f.key, f.example]));
      const nodes = fillTemplate(
        graphOf(fromFile(example?.text ?? '', catalog(), DEFAULT_AGENT)),
        values,
      ).nodes.map((n) => {
        const connection = connectionsOf(n.data.adapter ?? DEFAULT_AGENT)[0];
        return n.type === 'agent' && connection ? { ...n, data: { ...n.data, connection } } : n;
      });
      const red = nodes.flatMap((n) =>
        (n.data.queue ?? []).flatMap((item) =>
          'action' in item && item.expect === 'fails' ? [{ agent: n.id, step: item.id }] : [],
        ),
      );
      expect(red).toHaveLength(1);
      const { agent: tester = '', step = '' } = red[0] ?? {};
      /** Runs to the red step (every turn before it ends well, every OK given), then says how it went. */
      const run = (verdict: string) => {
        const { store, reply, sent } = setup(canvasNodes(nodes), manual);
        store.start();
        for (let turn = 0; turn < 20; turn++) {
          const { agents } = store.snapshot();
          const ok = Object.entries(agents).find(([, at]) => at.status === 'asking');
          if (ok) {
            store.decide(ok[0], ok[1].current ?? '', { choice: 'approve' });
          } else if (agents[tester]?.current === step) {
            reply(tester, false, verdict);
            break;
          } else {
            reply(sent.find((s) => s.done)?.agent ?? '', false, 'Done.');
          }
        }
        return { outcome: store.snapshot().agents[tester]?.outcomes[step], sent };
      };
      // Failing, as expected: the If after it is skipped.
      const failing = run('The new tests fail: nothing is built yet.\nFAILED');
      expect(failing.outcome).toBe('succeeded');
      // Passing already: the If after it asks for tests that fail.
      const passing = run('The new tests pass.\nSUCCEEDED');
      expect(passing.outcome).toBe('failed');
      const redo = passing.sent.at(-1);
      expect(redo?.agent).toBe(tester);
      expect(redo?.text).toMatch(/^The new tests pass before anything/);
      expect(failing.sent.map((s) => s.text)).not.toContain(redo?.text);
    },
  );

  it('keeps the Review loop running on NOT APPROVED, ending only on an APPROVED line', () => {
    const example = EXAMPLES.find((e) => e.name === 'Review loop');
    const nodes = graphOf(fromFile(example?.text ?? '', catalog(), DEFAULT_AGENT)).nodes.map(
      (node) => ({
        ...node,
        data: {
          ...node.data,
          connection:
            node.data.adapter === 'codex'
              ? ('codex.app-server' as const)
              : ('claude-code.sdk' as const),
        },
      }),
    );
    const { store, reply, where, sent } = setup(canvasNodes(nodes), manual);
    store.start();
    reply('coder');
    reply('reviewer', false, 'NOT APPROVED');
    expect(store.snapshot().agents.reviewer?.rounds).toEqual({ reviewing: { round: 2 } });
    expect(sent.find((turn) => turn.agent === 'reviewer')?.text).toMatch(
      /APPROVED.*line of its own/,
    );
    expect(where()).toEqual({ reviewer: 'waiting ready', coder: 'running implement' });
    reply('coder');
    reply('reviewer', false, 'The previous verdict was NOT APPROVED; there are still issues.');
    expect(store.snapshot().agents.reviewer?.rounds).toEqual({ reviewing: { round: 3 } });
    reply('coder');
    reply('reviewer', false, 'No changes needed.\r\n\r\nAPPROVED\r\n');
    expect(where()).toEqual({ reviewer: 'done', coder: 'done' });
    expect(store.snapshot().agents.reviewer?.outcomes.reviewing).toBe('succeeded');
  });
});
