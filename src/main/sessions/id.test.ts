import { expect, it } from 'vitest';

import { isNativeId } from './id';
import { ADAPTERS, isConversationId } from './adapters';

it.each(['-resume', '--help', '', 'a/b', 'a\\b', 'x\ny', 'x '.repeat(20), 'a'.repeat(129)])(
  'refuses %j at the platform minimum, including for an unknown adapter',
  (id) => {
    expect(isNativeId(id)).toBe(false);
    expect(isConversationId('future-agent', id)).toBe(false);
  },
);

it('leaves the stricter shape to the adapter after enforcing the platform minimum', () => {
  expect(isNativeId('session:one.2_a')).toBe(true);
  expect(isConversationId('future-agent', 'session:one.2_a')).toBe(true);
  for (const adapter of ADAPTERS) {
    for (const id of ['session:one', '01a1344c-68e9-7bf2-a777-b062d871bb26']) {
      expect(isConversationId(adapter.descriptor.id, id)).toBe(adapter.isConversationId(id));
    }
  }
});
