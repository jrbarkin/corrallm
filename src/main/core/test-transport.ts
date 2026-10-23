import { PARTIES } from '../../shared/api/surface';
import type { Party } from '../../shared/api/surface';
import type { Dispatcher } from './call';
import { allValid, unreachableCalls } from './test-registry';
import type { OpFixture, OutOfReach, UnreachableCall } from './test-registry';

/** The fixture calls a transport compares with core.call, including caller-specific reach. */
export function transportCases(
  core: Pick<Dispatcher, 'ops' | 'surface'>,
  name: string,
  fixture: OpFixture,
  world: OutOfReach,
  parties: readonly Party[] = PARTIES,
): UnreachableCall[] {
  const args = [
    ...allValid(fixture),
    ...fixture.invalid,
    ...Object.values(fixture.meetsRule ?? {}),
  ];
  return [
    ...args.flatMap((args) => parties.map((party) => ({ party, args }))),
    ...unreachableCalls(core, name, fixture, world).filter(({ party }) => parties.includes(party)),
  ];
}
