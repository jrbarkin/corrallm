import { describe, expect, it } from 'vitest';

import { consentIn } from '../adapter';
import type { Catalog } from '../adapter';
import { OPS } from '../api/registry';
import { MAX_CONSENT_DESCRIPTION, MAX_CONSENT_TITLE, MAX_CONSENTS } from '../api/limits';
import { MADE_UP, TWO_MADE_UP } from '../test-made-up';

/*
 * B22a C3: the consents an adapter asks you for, declared in its descriptor and served whole by
 * catalog.get, so a page can say what each means and take it back with no table of its own. A
 * declaration is words alone: it grants nothing, and names only its own adapter's connections.
 */

const parse = (catalog: Catalog) => OPS['catalog.get'].output.safeParse(catalog).success;

/** MADE_UP with its first adapter's consents replaced by `consents`. */
function withConsents(consents: unknown): Catalog {
  const catalog = structuredClone(MADE_UP);
  Reflect.set(catalog.adapters[0] ?? {}, 'consents', consents);
  return catalog;
}

describe('the consents an adapter declares (B22a C3)', () => {
  it('are served for unfamiliar adapters, by keys of their own, on their own connections', () => {
    expect(parse(MADE_UP)).toBe(true);
    expect(parse(TWO_MADE_UP)).toBe(true);
    const zed = MADE_UP.adapters[0]?.consents ?? [];
    expect(zed.map(({ key, connections }) => ({ key, connections }))).toEqual([
      { key: 'credits', connections: ['zed.acp'] },
      { key: 'share', connections: ['zed.acp', 'zed.free'] },
    ]);
    // A key is its adapter's own: another adapter may ask by the same one, for its connections.
    expect(consentIn(TWO_MADE_UP, 'yak', 'credits')?.connections).toEqual(['yak.terminal']);
    expect(consentIn(TWO_MADE_UP, 'zed', 'credits')?.connections).toEqual(['zed.acp']);
    expect(consentIn(TWO_MADE_UP, 'yak', 'share')).toBeUndefined();
    expect(consentIn(TWO_MADE_UP, 'nobody', 'credits')).toBeUndefined();
  });

  it('refuses a declaration past its bounds, of another shape, or naming another connection', () => {
    const one = {
      key: 'credits',
      title: 'Spend your credits',
      description: 'Asked before a turn spends them.',
      connections: ['zed.acp'],
    };
    expect(parse(withConsents([one]))).toBe(true);
    expect(parse(withConsents([]))).toBe(true);
    expect(
      parse(
        withConsents([
          { ...one, title: 'x'.repeat(MAX_CONSENT_TITLE) },
          { ...one, key: 'other', description: 'x'.repeat(MAX_CONSENT_DESCRIPTION) },
        ]),
      ),
    ).toBe(true);
    for (const consents of [
      Array.from({ length: MAX_CONSENTS + 1 }, (_, n) => ({ ...one, key: `k${String(n)}` })),
      [{ ...one, title: 'x'.repeat(MAX_CONSENT_TITLE + 1) }],
      [{ ...one, title: '' }],
      [{ ...one, description: 'x'.repeat(MAX_CONSENT_DESCRIPTION + 1) }],
      [{ ...one, key: '-credits' }],
      [{ ...one, key: '' }],
      [{ ...one, connections: [] }],
      [{ ...one, connections: ['yak.terminal'] }],
      [{ ...one, connections: ['zed.acp', 'zed.acp'] }],
      [one, one],
      // A declaration grants nothing: it has no field that could say it was given.
      [{ ...one, given: true }],
      [{ ...one, account: 'me@example.com' }],
      'credits',
    ])
      expect(parse(withConsents(consents)), JSON.stringify(consents).slice(0, 80)).toBe(false);
  });
});
