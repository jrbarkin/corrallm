import type { AdapterId, Catalog } from '../../../shared/adapter';
import type { ArgsOf, ResultOf } from '../../../shared/api/registry';
import type { OpName } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { Settings } from '../../settings';
import type { UsageReadings } from '../../usage';
import type { LinkOpener } from '../../links';
import type { FileRevealer } from '../../reveal';
import type { SessionManager } from '../../sessions/manager';
import type { Windows } from '../windows';
import type { Topics } from '../topics';
import type { OpContext } from '../call';
import type { Engines } from '../engines';
import type { HostServices } from '../host';
import type { TokenStore } from '../tokens';
import { appOps } from './app';
import { catalogOps } from './catalog';
import { conversationOps } from './conversation';
import { linkOps } from './link';
import { runOps } from './run';
import { sessionOps } from './session';
import { settingsOps } from './settings';
import { terminalOps } from './terminal';
import { templatesOps } from './templates';
import { topicsOps } from './topics';
import { usageOps } from './usage';
import { waitOps } from './wait';
import { windowOps } from './window';

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
  topics: Pick<Topics, 'subscribe' | 'unsubscribe'>;
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  /** What every adapter declares. */
  catalog: Catalog;
  /** The adapter agents run when none is chosen. */
  defaultAdapter: AdapterId;
  settings: Pick<Settings, 'get'>;
  /** The agents’ environment, read from the login shell when first needed. */
  environment: () => Promise<Readonly<Record<string, string>>>;
  usage: Pick<UsageReadings, 'state' | 'setRule' | 'simulate'>;
  links: Pick<LinkOpener, 'open'>;
  reveal: Pick<FileRevealer, 'reveal'>;
  windows: Pick<Windows, 'canvasOf'>;
  sessions: Pick<
    SessionManager,
    'attachTerminal' | 'detachTerminal' | 'inputTerminal' | 'resizeTerminal' | 'dropOnTerminal'
  >;
  /** The canvases the core runs. */
  engines: Engines;
  /** Whether an agent is a lead now, as kept on this machine. */
  isLead: (canvas: CanvasId, agent: string) => boolean;
  /** The locale what the core says tells times of day in: the runtime's own, when none. */
  locale?: string;
  /** Whatever needs the desktop. */
  host: HostServices;
  /** The outside tokens: whether one was replaced or expires, as a call it made still goes on. */
  tokens: Pick<TokenStore, 'revoked' | 'onRevoke' | 'expiresOf'>;
}

export function implementations(services: OpServices): Implementations {
  return {
    ...topicsOps(services),
    ...appOps(services),
    ...catalogOps(services),
    ...templatesOps(services),
    ...conversationOps(services),
    ...sessionOps(services),
    ...settingsOps(services),
    ...runOps(services),
    ...usageOps(services),
    ...waitOps(services),
    ...linkOps(services),
    ...windowOps(services),
    ...terminalOps(services),
  };
}
