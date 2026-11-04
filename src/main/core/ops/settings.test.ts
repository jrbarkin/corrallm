import { describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../../../shared/adapter';
import { TWO_MADE_UP } from '../../../shared/test-made-up';
import type { OpContext } from '../call';
import type { OpServices } from '.';
import { settingsOps } from './settings';

/*
 * B22a C3: which consents are taken back as declared is read from the catalog the core is given,
 * whatever adapters it names: no table of the platform's own. Here, two unfamiliar adapters, one
 * asking two consents on different connections, the other one by a key the first asks by too.
 */

function ops(catalog: Catalog) {
  const resetConsent = vi.fn(() => Promise.resolve(true));
  const services = {
    catalog,
    settings: { resetConsent },
    links: {},
    notifications: {},
    api: () => ({ state: 'stopped', port: null }),
  } as unknown as OpServices;
  const ctx = { party: 'you', published: vi.fn() } as unknown as OpContext;
  const set = settingsOps(services)['settings.set'];
  return {
    resetConsent,
    take: (adapter: string, key: string) =>
      set({ consent: { kind: 'adapter', adapter, key } }, ctx),
  };
}

describe('taking back a consent, by the catalog the core is given (B22a C3)', () => {
  it('treats each adapter’s own declared keys as declared, and any other as only what is kept', async () => {
    const { resetConsent, take } = ops(TWO_MADE_UP);
    for (const [adapter, key] of [
      ['zed', 'credits'],
      ['zed', 'share'],
      ['yak', 'credits'],
      ['yak', 'share'],
      ['zed', 'plan'],
      ['nobody', 'credits'],
    ] as const)
      await take(adapter, key);
    expect(resetConsent.mock.calls).toEqual([
      ['zed', 'credits', true],
      ['zed', 'share', true],
      ['yak', 'credits', true],
      ['yak', 'share', false],
      ['zed', 'plan', false],
      ['nobody', 'credits', false],
    ]);
  });
});

describe('settings that can’t be read (B22a C6)', () => {
  /** A read that fails as a file system does, naming the profile's file. */
  const failing = () =>
    Promise.reject(
      new Error("EACCES: permission denied, open '/home/someone/.corrallm/settings.json'"),
    );

  it.each([
    ['you', 'get'],
    ['outside-read', 'get'],
    ['you', 'apiPort'],
  ] as const)(
    'refuses %s’s read as unavailable in fixed words when its %s fails, never the error’s',
    async (party, which) => {
      const ok = () => Promise.resolve({ defaultAdapter: null, consents: {} });
      const services = {
        catalog: TWO_MADE_UP,
        settings: { get: which === 'get' ? failing : ok, apiPort: which === 'get' ? ok : failing },
        links: { sites: () => Promise.resolve([]), builtIn: () => [] },
        notifications: { status: () => undefined },
        api: () => ({ state: 'stopped', port: null }),
      } as unknown as OpServices;
      const ctx = { party, published: vi.fn() } as unknown as OpContext;
      const read = settingsOps(services)['settings.get']({}, ctx);
      await expect(read).rejects.toMatchObject({
        code: 'unavailable',
        message: 'corrallm couldn’t read your settings.',
      });
    },
  );
});
