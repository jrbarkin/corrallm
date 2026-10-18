import type { Implementations, OpServices } from '.';

/** Usage readings and rules (Core Server §4 I). */
export function usageOps({ usage }: OpServices): Pick<Implementations, 'usage.get'> {
  return {
    'usage.get': () => usage.state(),
  };
}
