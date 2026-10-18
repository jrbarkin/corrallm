import type { ArgsOf, ResultOf } from '../../../shared/api/registry';
import type { OpName } from '../../../shared/api/surface';
import type { UsageReadings } from '../../usage';
import type { OpContext } from '../call';
import type { HostServices } from '../host';
import { appOps } from './app';
import { usageOps } from './usage';

/*
 * What each operation does, by area (Core Server §8.2): one implementation per op in the registry,
 * a mapped type, so a missing one is a compile error. core.call has checked the caller, the
 * arguments, reach and rules before one runs, so an implementation only does its work.
 */

export type Implementations = {
  [N in OpName]: (args: ArgsOf<N>, ctx: OpContext) => ResultOf<N> | Promise<ResultOf<N>>;
};

/** What the operations act on: the services the core composes (createCore). */
export interface OpServices {
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  usage: Pick<UsageReadings, 'state'>;
  /** Whatever needs the desktop. */
  host: HostServices;
}

export function implementations(services: OpServices): Implementations {
  return { ...appOps(services), ...usageOps(services) };
}
