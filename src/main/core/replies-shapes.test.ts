import { expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { fitsChoices } from './replies';

it('keeps prompt feedback separate from a hold’s typed correction', () => {
  const hold: NeedsItem = {
    id: 'hold/worker/1/item',
    canvas: '00000000-0000-4000-8000-000000000001' as CanvasId,
    agent: 'worker',
    kind: 'hold',
    for: 'you',
    by: ['you'],
    title: 'Approve the work?',
    choices: [{ value: 'approve', label: 'Approve' }],
    text: { placeholder: 'What to revise' },
    answerIn: 'api',
  };
  expect(fitsChoices(hold, { choice: 'approve', feedback: 'Keep this feedback' })).toContain(
    'feedback',
  );
  expect(fitsChoices(hold, { text: 'Make it shorter' })).toBeUndefined();
  expect(fitsChoices(hold, { choice: 'approve' })).toBeUndefined();
});
