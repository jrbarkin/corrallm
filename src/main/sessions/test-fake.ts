import type { AdapterId } from '../../shared/adapter';
import { ADAPTERS } from './adapters';
import type { FakeOptions } from './fake';

/** Select a native regression fixture through its registered adapter, never its folder. */
export function fakeConnector({
  adapter = 'claude-code',
  ...options
}: FakeOptions & { adapter?: AdapterId } = {}) {
  const make = ADAPTERS.find((one) => one.descriptor.id === adapter)?.fake;
  if (make === undefined) throw new Error(`No fake fixture for ${adapter}`);
  return make(options);
}
