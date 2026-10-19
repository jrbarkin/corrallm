import { parseBackend, parseWindows } from '../../../shared/usage';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';

/** Usage readings and rules (Core Server §4 I). */
export function usageOps({
  usage,
  catalog,
}: OpServices): Pick<Implementations, 'usage.get' | 'usage.setRule' | 'usage.simulate'> {
  const backends = catalog.usageBackends.map((backend) => backend.id);
  return {
    'usage.get': () => usage.state(),
    'usage.setRule': ({ backend, rule }) => {
      usage.setRule(
        checked(() => parseBackend(backend, backends)),
        rule,
      );
      return {};
    },
    'usage.simulate': ({ backend, windows }) => {
      const selected = checked(() => parseBackend(backend, backends));
      const reading = windows === null ? null : checked(() => parseWindows(windows, Date.now()));
      usage.simulate(selected, reading);
      return {};
    },
  };
}

/** A usage parser's failure as invalid arguments, retaining its reason. */
function checked<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new OpFailure('invalid', error.message);
    }
    throw error;
  }
}
