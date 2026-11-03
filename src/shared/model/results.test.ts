import { describe, expect, it } from 'vitest';

import { attemptReports } from './results';

const attempt = '11111111-1111-4111-8111-111111111111';
const task = { agent: 'a', item: 'build', attempt };
const verdict = { v: 1, outcome: 'succeeded', summary: 'Built it.' } as const;

describe('attemptReports', () => {
  it('reads an attempt’s verdict and summary from its result record', () => {
    const reports = attemptReports([{ kind: 'result', task, verdict }]);
    expect(reports.get(attempt)).toEqual({ outcome: 'succeeded', summary: 'Built it.' });
  });

  it('marks an attempt waiting while an ask made in its turn is open', () => {
    const ask = {
      v: 1,
      type: 'question',
      questions: [],
      deadline: 1,
      task: { owner: 'a', item: 'build', attempt },
    };
    expect(attemptReports([{ kind: 'prompt', ask }]).get(attempt)).toEqual({ waiting: true });
  });

  it('does not mark an attempt waiting once its ask is settled, or for a taskless ask', () => {
    const ask = {
      v: 1,
      type: 'question',
      questions: [],
      deadline: 1,
      task: { owner: 'a', item: 'build', attempt },
    };
    const settled = { kind: 'prompt', ask, settled: { type: 'answered' } };
    const taskless = { kind: 'prompt', ask: { ...ask, task: undefined } };
    expect(attemptReports([settled, taskless]).size).toBe(0);
  });

  it('keeps both facts of one attempt', () => {
    const ask = {
      v: 1,
      type: 'question',
      questions: [],
      deadline: 1,
      task: { owner: 'a', item: 'build', attempt },
    };
    const reports = attemptReports([
      { kind: 'prompt', ask },
      { kind: 'result', task, verdict },
    ]);
    expect(reports.get(attempt)).toEqual({
      waiting: true,
      outcome: 'succeeded',
      summary: 'Built it.',
    });
  });
});
