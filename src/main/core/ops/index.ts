import type { AdapterId, Catalog } from '../../../shared/adapter';
import type { ArgsOf, ProducedOf } from '../../../shared/api/registry';
import type { OpName } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { NeedsItem } from '../../../shared/model/needs';
import type { Settings } from '../../settings';
import type { UsageReadings } from '../../usage';
import type { LinkOpener } from '../../links';
import type { FileRevealer } from '../../reveal';
import type { ProjectFiles } from '../../files';
import type { ProjectRootResolver } from '../workspaces/resolver';
import type { SetupService } from '../workspaces/setup';
import type { ReplyHandler } from '../replies';
import type { SessionManager } from '../../sessions/manager';
import type { Windows } from '../windows';
import type { Topics } from '../topics';
import type { OpContext } from '../call';
import type { Documents } from '../canvas/documents';
import type { Lifecycle } from '../canvas/lifecycle';
import type { Proposals } from '../canvas/proposals';
import type { FileReviews } from '../canvas/reviews';
import type { CanvasStates } from '../canvas/states';
import type { Engines } from '../engines';
import type { HostServices } from '../host';
import type { StalledTurns } from '../stalled';
import type { TokenStore } from '../tokens';
import { agentOps } from './agent';
import { queueOps } from './queue';
import { appOps } from './app';
import { batchOps } from './batch';
import { replyOps } from './reply';
import { canvasOps } from './canvas';
import { canvasToolsOps } from './canvas-tools';
import { canvasesOps } from './canvases';
import { catalogOps } from './catalog';
import { filesOps } from './files';
import { conversationOps } from './conversation';
import { linkOps } from './link';
import { projectOps } from './project';
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
  [N in OpName]: (args: ArgsOf<N>, ctx: OpContext) => ProducedOf<N> | Promise<ProducedOf<N>>;
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
  directories: ProjectRootResolver;
  files: Pick<ProjectFiles, 'find'>;
  windows: Pick<Windows, 'canvasOf' | 'shownIn'>;
  sessions: Pick<
    SessionManager,
    | 'attachTerminal'
    | 'detachTerminal'
    | 'inputTerminal'
    | 'resizeTerminal'
    | 'dropOnTerminal'
    | 'interrupt'
    | 'interruptIf'
  >;
  stalled: Pick<StalledTurns, 'items' | 'take'>;
  runProblems?: (canvas: CanvasId) => readonly NeedsItem[];
  /** The canvases the core runs. */
  engines: Engines;
  /** Each canvas's lifetime: made, opened, saved, closed, its folder chosen. */
  lifecycle: Lifecycle;
  /**
   * Each canvas's document: a canvas made, kept or dropped (canvas.create), and a file changed on
   * disk applied or kept over (reply).
   */
  documents: Pick<
    Documents,
    'create' | 'keep' | 'drop' | 'forget' | 'applyFile' | 'keepFile' | 'createdBy'
  >;
  /** What the core says of each canvas it keeps: its entities, and the list of them. */
  states: Pick<CanvasStates, 'read' | 'list' | 'keeps'>;
  /** The proposals waiting for you on each canvas. */
  proposals: Pick<Proposals, 'get' | 'items' | 'settled' | 'settle' | 'settlement'>;
  /** The review of each canvas's file changed on disk, waiting for you. */
  reviews: Pick<FileReviews, 'get' | 'items' | 'settled'>;
  /** What waits for an answer on a canvas, for you, by its id: its Needs item. */
  needOf: (canvas: CanvasId, id: string) => NeedsItem | undefined;
  /** Whether an agent is a lead now, as kept on this machine. */
  isLead: (canvas: CanvasId, agent: string) => boolean;
  /** The locale what the core says tells times of day in: the runtime's own, when none. */
  locale?: string;
  /** Whatever needs the desktop. */
  host: HostServices;
  /** The outside tokens: whether one was replaced or expires, as a call it made still goes on. */
  tokens: Pick<TokenStore, 'revoked' | 'onRevoke' | 'expiresOf'>;
  /**
   * The worktrees' setup (workspaces/setup.ts): its cards, their answers and the setup command you
   * set. None until B9a X11b composes the workspaces: then no card is raised, and setting a command
   * is unavailable.
   */
  setups?: SetupService;
  /**
   * The reply router's handlers for what a canvas's runtime asks (its run's holds, its sessions'
   * prompts: run-replies.ts) and a workspace's change (workspaces/rebind.ts), B11 C7's: composed
   * with the prepared typed `reply` until X9 registers it. None: those are answered in corrallm's
   * window.
   */
  replies?: readonly ReplyHandler[];
}

export function implementations(services: OpServices): Implementations {
  return {
    ...topicsOps(services),
    ...appOps(services),
    ...catalogOps(services),
    ...templatesOps(services),
    ...projectOps(services),
    ...filesOps(services),
    ...canvasesOps(services),
    ...canvasOps(services),
    ...canvasToolsOps(services),
    ...batchOps(),
    ...agentOps(services),
    ...queueOps(),
    ...conversationOps(services),
    ...replyOps(services),
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
