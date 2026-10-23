import { describe, expect, it } from 'vitest';

import { PARTIES } from '../../shared/api/surface';
import {
  allValid,
  TEST_FIXTURES,
  TEST_OUT_OF_REACH,
  testRegistry,
  unreachableCalls,
} from './test-registry';
import { transportCases } from './test-transport';

const core = testRegistry();
const fixture = TEST_FIXTURES['test.agent'];
const ordinary = [
  ...allValid(fixture),
  ...fixture.invalid,
  ...Object.values(fixture.meetsRule ?? {}),
];

describe('transport fixture calls', () => {
  it('checks each ordinary fixture for every caller', () => {
    const cases = transportCases(core, 'test.agent', fixture, TEST_OUT_OF_REACH);
    for (const args of ordinary) {
      expect(cases.filter((one) => one.args === args).map((one) => one.party)).toEqual(PARTIES);
    }
  });

  it('keeps generated reach checks on their caller, instead of replaying them as you', () => {
    const cases = transportCases(core, 'test.agent', fixture, TEST_OUT_OF_REACH);
    const generated = cases.filter((one) => !ordinary.includes(one.args));
    expect(generated).toEqual(unreachableCalls(core, 'test.agent', fixture, TEST_OUT_OF_REACH));
  });

  it('never gives a window the unreachable ids generated for a token', () => {
    const cases = transportCases(core, 'test.agent', fixture, TEST_OUT_OF_REACH, ['you']);
    expect(cases).toEqual(ordinary.map((args) => ({ party: 'you', args })));
  });

  it('keeps every token fixture and its reach checks over HTTP', () => {
    const parties = PARTIES.filter((party) => party !== 'you');
    const cases = transportCases(core, 'test.agent', fixture, TEST_OUT_OF_REACH, parties);
    expect(cases.some((one) => one.party === 'you')).toBe(false);
    for (const args of ordinary) {
      expect(cases.filter((one) => one.args === args).map((one) => one.party)).toEqual(parties);
    }
    expect(cases.filter((one) => !ordinary.includes(one.args))).toEqual(
      unreachableCalls(core, 'test.agent', fixture, TEST_OUT_OF_REACH),
    );
  });
});
