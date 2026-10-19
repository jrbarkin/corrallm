import type { Implementations, OpServices } from '.';
import { windowOf } from './window';

/** A subscription belongs to the calling window, never one named in its arguments. */
export function topicsOps({
  topics,
}: OpServices): Pick<Implementations, 'topics.subscribe' | 'topics.unsubscribe'> {
  return {
    'topics.subscribe': ({ topic }, ctx) => topics.subscribe(windowOf(ctx), topic, ctx),
    'topics.unsubscribe': async ({ topic }, ctx) => {
      await topics.unsubscribe(windowOf(ctx), topic);
      return {};
    },
  };
}
