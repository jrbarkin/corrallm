import type { Catalog } from '../../../shared/adapter';
import type { ArgsOf, ResultOf } from '../../../shared/api/registry';
import type { OpName } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { UsageReadings } from '../../usage';
import type { OpContext } from '../call';
import type { Engines } from '../engines';
import type { HostServices } from '../host';
import { appOps } from './app';
import { catalogOps } from './catalog';
import { conversationOps } from './conversation';
import { runOps } from './run';
import { sessionOps } from './session';
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
  /** What every adapter declares. */
  catalog: Catalog;
  usage: Pick<UsageReadings, 'state'>;
  /** The canvases the core runs. */
  engines: Engines;
  /** Whether an agent is a lead now, as kept on this machine. */
  isLead: (canvas: CanvasId, agent: string) => boolean;
  /** The locale what the core says tells times of day in: the runtime's own, when none. */
  locale?: string;
  /** Whatever needs the desktop. */
  host: HostServices;
}

export function implementations(services: OpServices): Implementations {
  return {
    ...appOps(services),
    ...catalogOps(services),
    ...conversationOps(services),
    ...sessionOps(services),
    ...runOps(services),
    ...usageOps(services),
  };
}
