import { threadTitle } from '../agent/session';
import { CONDITIONS, isIf, isMessage, isWait } from './queue';
import type { Condition, QueueItem } from './queue';

/** How a condition reads after "If". */
export const ifText = (condition: Condition): string =>
  condition.kind === 'outputContains'
    ? `the output contains "${condition.text}"`
    : condition.kind === 'freeText'
      ? condition.text
      : (CONDITIONS.find((c) => c.kind === condition.kind)?.label ?? '');

/** How a queue item reads when another agent waits for it. */
export const itemLabel = (item: QueueItem): string =>
  isWait(item)
    ? 'its wait'
    : isIf(item)
      ? `If ${ifText(item.if)}`
      : isMessage(item)
        ? item.message.trim() === ''
          ? 'an empty message'
          : `“${threadTitle(item.message, 24)}”`
        : item.action;
