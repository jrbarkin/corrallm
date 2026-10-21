import type { ProducedOf } from '../../../shared/api/registry';
import type { Implementations, OpServices } from '.';
import { windowOf } from './window';

/** A subscription belongs to the calling window, never one named in its arguments. */
export function topicsOps({
  topics,
}: OpServices): Pick<Implementations, 'topics.subscribe' | 'topics.unsubscribe'> {
  return {
    // A canvas's entities are its document's rows, which its schema describes loosely.
    'topics.subscribe': (request, ctx) =>
      topics.subscribe(windowOf(ctx), request, ctx) as Promise<ProducedOf<'topics.subscribe'>>,
    'topics.unsubscribe': async (request, ctx) => {
      await topics.unsubscribe(windowOf(ctx), request);
      return {};
    },
  };
}
