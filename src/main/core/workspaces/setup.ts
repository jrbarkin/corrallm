import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  accessSync,
} from 'node:fs';
import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';
import type { PartyId } from '../../../shared/model/messages';
import type { NeedChoice, NeedsItem } from '../../../shared/model/needs';
import {
  MAX_SETUP_COMMAND_BYTES,
  SUGGESTED_COMMANDS,
  UNSEEN_IN_COMMAND,
  detectSetup,
} from '../../../shared/model/worktree-setup';
import type { SetupDetection } from '../../../shared/model/worktree-setup';
import { CopyError, O_NOFOLLOW, copyLocalFiles } from './copy';
import type { CopyRecord } from './copy';
import { GitError } from './git';
import type { GitRunner } from './git';
import type { Provisioner } from './provision';
import type { ProjectRootResolver } from './resolver';
import { SetupProcess } from './setup-run';
import type { SetupExit, SetupProcesses } from './setup-run';
import { WorkspaceStoreError } from './store';
import type {
  RepositoryRecord,
  SetupRecord,
  SetupSource,
  ShellKind,
  WorkspaceStore,
  WorktreeRecord,
} from './store';

/*
 * A new workspace's setup (B9a Design §4, and its frozen review, §14 items 2 and 3): the picked
 * checkout's local files copied in (copy.ts), then one card in Needs you, for the workspace, not
 * for each of its agents. What may run is fixed by the core, never by a repository: the command you
 * set for the picked repository (`project.setSetupCommand`: one line, at most 4 KiB, run under the
 * fixed POSIX shell), or else the fixed table's for its lockfile (pnpm, npm: an argument list, no
 * shell), or none, which only Skip answers. Nothing from a token, a canvas or the repository's own
 * files (package.json's scripts, a manifest, a lockfile's contents) ever becomes a command.
 *
 * The card shows exactly what would run, where (the checkout and its branch), where it came from and
 * which files were copied (their names only), and that installing dependencies can run scripts and
 * use the network. Only you answer it (`reply`), only while it is current: its id names the setup's
 * generation, which moves on whenever what it would run changes, so an answer to a card that was
 * raised anew is stale, and Run re-checks, as it is allowed, that what runs hashes to what was shown.
 *
 * - Run: your approval and the running attempt are on disk before anything runs (`startSetup`);
 *   the command runs once, in the workspace's checkout verified again just before (setup-run.ts).
 *   Done, the workspace is ready; failed, it waits with its exit code for Retry (a new attempt) or
 *   Skip. At most `maxRunning` run at once on a profile; one at a time per workspace.
 * - Always: Run, and that exact command (its spec hash: the command and how it runs) runs by itself
 *   in this repository's later new workspaces. A changed command clears it (the store's
 *   `setProjectCommand`) and raises every waiting card anew with the new one.
 * - Skip: its agents start without it.
 * - Stop: its whole process group ended (core/children.ts), then Retry or Skip.
 *
 * The core closing ends what runs and marks it interrupted; a crash's is marked so as the next core
 * starts (`recover`, after the process owner ended the crashed core's groups). An interrupted setup
 * never runs again by itself, Always or not: whether it did what it does is unknown. Windows can't
 * yet end a setup command's whole process tree, so no setup runs there (a release blocker): its
 * card says so and offers Skip.
 *
 * createCore composes this for every host; CoreConfig.setups is a test override.
 */

/** A setup card's id: its workspace's, at its setup's generation. */
export function setupNeedId(workspace: string, generation: number): string {
  return `setup/${workspace}/${String(generation)}`;
}

const NEED = /^setup\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{1,16})$/;

/** The choices a setup card may offer. */
export type SetupChoice = 'run' | 'always' | 'skip' | 'stop' | 'retry';
/** What a reply to one did. */
export type SetupOutcome = 'started' | 'skipped' | 'stopped';

export type SetupErrorCode = 'not-found' | 'conflict' | 'refused' | 'invalid' | 'unavailable';

/** A refusal, with the sentence a person is told: `reply`'s and `project.setSetupCommand`'s. */
export class SetupError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

/** What runs: an argument list of the fixed table's, the command you set under a fixed shell, or none. */
export type RunSpec =
  | { form: 'none' }
  | { form: 'argv'; executable: keyof typeof SUGGESTED_COMMANDS; args: readonly string[] }
  | { form: 'shell'; shell: ShellKind; command: string };

/** The hash of exactly what runs and how: what a setup is offered and Always allowed by. */
export function specHash(spec: RunSpec): string {
  const canonical =
    spec.form === 'none'
      ? ['none']
      : spec.form === 'argv'
        ? ['argv', spec.executable, ...spec.args]
        : ['shell', spec.shell, spec.command];
  return createHash('sha256')
    .update(`corrallm setup spec 1\0${JSON.stringify(canonical)}`)
    .digest('hex');
}

/** A reply's cancellation boundary, supplied by core.call. */
export interface SetupCall {
  /** Checks cancellation and makes the call irreversible immediately before its write. */
  noReturn(): void;
}

/** What the setup service does for the core: what `needs`, `reply` and the op call. */
export interface SetupService {
  /** Provisioning completed: prepare its local files and offer setup. */
  prepare?(workspace: string): Promise<void>;
  reconcile?(canvas?: CanvasId): Promise<void>;
  /** The setup cards of a canvas's workspaces: yours alone, so on no agent. */
  items(canvas: CanvasId): NeedsItem[];
  reply(
    canvas: CanvasId,
    to: string,
    choice: string,
    by: PartyId,
    call?: SetupCall,
  ): Promise<{ outcome: SetupOutcome }>;
  /**
   * Why the card `to` names waits no more, if it was raised (the reply router's): settled (done or
   * skipped), or raised anew since (what it would run changed). None if no such card was raised.
   */
  gone(canvas: CanvasId, to: string): SetupError | undefined;
  /** `project.setSetupCommand`: the command for the canvas's picked repository (none: detected). */
  setCommand(
    canvas: CanvasId,
    command: string | null,
  ): Promise<{ changed: boolean; offered: number }>;
  /** `project.clearSetupApproval`: nothing runs by itself for the canvas's repository any more. */
  clearAlways(canvas: CanvasId): Promise<{ cleared: boolean }>;
  /** Whether a setup command runs (or waits to run) in the workspace now: a writer there. */
  running(workspace: string): boolean;
  /** The local files copied into the workspace, by name (none: unknown): never committed by it. */
  copied?(workspace: string): readonly string[] | undefined;
  /** How many setup commands run (or wait to run) now: jobs, to the core's presence (B14 C5). */
  jobs(): number;
  /**
   * Its workspace removed (B9a C7's cleanup): what runs there is ended, and what its setup kept
   * beside the database (its log, its copy record) removed.
   */
  forget(workspace: string): Promise<void>;
  /** As the core starts, after its process owner's recovery: what ran is interrupted. */
  recover(): Promise<void>;
  /** As the core closes, before its process owner does: what runs is ended, and interrupted. */
  close(): Promise<void>;
}

export interface WorkspaceSetupsDeps {
  workspaces: WorkspaceStore;
  /** A workspace's checkout verified at each use, and the repository a picked folder is. */
  provisioner: Pick<Provisioner, 'checkout' | 'repository'>;
  git: GitRunner;
  /** The canvas's picked project folder. */
  directories: ProjectRootResolver;
  /** The core's process owner: every setup command is a child it records and ends. */
  processes: SetupProcesses;
  /** The agents' environment: what a setup command runs with. */
  environment: () => Promise<Readonly<Record<string, string>>>;
  /** A private folder of the profile's (`<profile>/workspaces/setup`): logs and copy records. */
  folder: string;
  /** The profile's folder: nothing in it is ever copied into a workspace. */
  profile?: string;
  platform?: NodeJS.Platform;
  /** Hears that a canvas's setup cards may have changed. */
  changed?: (canvas: CanvasId) => void;
  /** The names a workspace's card gives its agents (its bound agents', or its owner's, by id). */
  members?: (worktree: WorktreeRecord) => readonly string[];
  /** At most this many setup commands run at once on the profile. */
  maxRunning?: number;
  /** How long one may run before it is ended. */
  timeoutMs?: number;
  locale?: string;
}

/** Only you decide what runs on your computer: every choice of a setup card is yours. */
const YOURS = 'Only you decide what runs on your computer.';
const WINDOWS =
  'corrallm doesn’t run setup commands on Windows yet: it can’t yet end all of a command’s processes there. Set up the worktree yourself, then Skip.';
const MAX_RUNNING = 2;
const TIMEOUT_MS = 30 * 60_000;
/** What a card shows of a command's output: its last lines, escaped. */
const MAX_SHOWN_CHARS = 2000;
const MAX_SHOWN_LINES = 20;
const MAX_TAIL_READ = 8 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_PACKAGE_JSON = 1024 * 1024;
/** The setup states it may still be asked to run, or skipped. */
const DECIDABLE: readonly SetupRecord['state'][] = ['pending', 'failed', 'interrupted'];

interface Offer {
  spec: RunSpec;
  source: SetupSource;
  command: string | null;
  /** Why none was detected, if none was. */
  why?: string;
}

interface Attempt {
  canvas: CanvasId;
  workspace: string;
  generation: number;
  process?: SetupProcess;
  endedBy?: 'stop' | 'shutdown';
  /** While it waits for a slot: wakes it without one (it was stopped first). */
  wake?: () => void;
  done: Promise<void>;
}

export class WorkspaceSetups implements SetupService {
  readonly #deps: WorkspaceSetupsDeps;
  readonly #windows: boolean;
  readonly #max: number;
  readonly #prepares = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, Attempt>();
  /** How each workspace's last attempt ended, as this core saw it. */
  readonly #exits = new Map<string, SetupExit>();
  /** Why no command was detected, by workspace, as offered. */
  readonly #reasons = new Map<string, string>();
  readonly #tails = new Map<string, string>();
  readonly #copies = new Map<string, CopyRecord>();
  readonly #waiting: ((slotted: boolean) => void)[] = [];
  #active = 0;
  #closing = false;

  constructor(deps: WorkspaceSetupsDeps) {
    this.#deps = deps;
    this.#windows = (deps.platform ?? process.platform) === 'win32';
    this.#max = deps.maxRunning ?? MAX_RUNNING;
  }

  // As the core starts.

  async recover(): Promise<void> {
    const interrupted = await this.#deps.workspaces.write((w) => w.interruptSetups());
    for (const canvas of new Set(
      interrupted.flatMap((id) => this.#deps.workspaces.worktree(id)?.canvas ?? []),
    )) {
      this.#changed(canvas);
    }
  }

  /** Every workspace in `setup` (of the canvas, or every canvas) not yet offered its setup, offered it. */
  async reconcile(canvas?: CanvasId): Promise<void> {
    const trees = this.#deps.workspaces
      .worktreesIn(['setup'])
      .filter((tree) => canvas === undefined || tree.canvas === canvas);
    for (const tree of trees) {
      try {
        await this.prepare(tree.id);
      } catch (error) {
        console.error('Could not offer a worktree’s setup:', error);
      }
    }
  }

  // Offering it.

  /**
   * A workspace C5 left in `setup`: its local files copied in, then its setup offered, once (and
   * run, if what would run is what you allowed always for its repository). Shared while it goes
   * on; nothing if it was offered already or isn't in `setup`.
   */
  prepare(workspace: string): Promise<void> {
    const going = this.#prepares.get(workspace);
    if (going !== undefined) return going;
    const prepared = this.#prepare(workspace).finally(() => this.#prepares.delete(workspace));
    this.#prepares.set(workspace, prepared);
    return prepared;
  }

  async #prepare(id: string): Promise<void> {
    const { workspaces, provisioner } = this.#deps;
    if (this.#closing) return;
    const tree = workspaces.worktree(id);
    if (tree?.state !== 'setup' || workspaces.setup(id) !== undefined) return;
    const repository = workspaces.repository(tree.repository);
    if (repository === undefined) return;
    const checkout = await provisioner.checkout(id);
    if (checkout.state !== 'setup') return;
    let copied = this.#copyRecord(id);
    if (copied === undefined) {
      try {
        copied = await copyLocalFiles(this.#deps.git, {
          repository,
          worktree: checkout.worktree,
          cwd: checkout.cwd,
          ...(this.#deps.profile === undefined ? {} : { profile: this.#deps.profile }),
        });
      } catch (error) {
        if (!(error instanceof CopyError)) throw error;
        await this.#hold(tree, `copy-${error.code}`);
        return;
      }
      this.#keepCopyRecord(id, copied);
    }
    let offer: Offer;
    try {
      offer = await this.#offerOf(tree, repository);
    } catch (error) {
      if (!(error instanceof GitError) || error.fault === 'refused') throw error;
      await this.#hold(tree, 'setup-detection');
      return;
    }
    const hash = specHash(offer.spec);
    const record = copied;
    const result = await workspaces.write((w) => {
      if (w.setup(id) !== undefined || w.worktree(id)?.state !== 'setup') return undefined;
      const setup = w.offerSetup(id, {
        command: offer.command,
        source: offer.source,
        specHash: hash,
        copyManifestHash: record.hash,
      });
      const always = w.projectSetup(repository.id)?.alwaysSpecHash ?? null;
      // What you allowed always runs by itself in a new workspace: only that exact command.
      if (offer.command === null || always !== hash || this.#windows || this.#closing) {
        return { setup, started: undefined };
      }
      return {
        setup,
        started: w.startSetup(id, {
          generation: setup.generation,
          by: 'you',
          logKey: logKey(setup),
        }),
      };
    });
    if (offer.why !== undefined) this.#reasons.set(id, offer.why);
    if (result?.started !== undefined) this.#launch(tree, result.started, offer.spec);
    this.#changed(tree.canvas);
  }

  /** The workspace in error, saying why, as a check of its own would leave it. */
  async #hold(tree: WorktreeRecord, code: string): Promise<void> {
    try {
      await this.#deps.workspaces.write((w) =>
        w.transition(tree.id, { from: 'setup', to: 'error', errorCode: code }),
      );
    } catch (error) {
      if (!(error instanceof WorkspaceStoreError && error.code === 'stale')) throw error;
    }
    this.#changed(tree.canvas);
  }

  /** What the workspace's setup would run now: your command for its repository, or the table's. */
  async #offerOf(tree: WorktreeRecord, repository: RepositoryRecord): Promise<Offer> {
    const kept = this.#deps.workspaces.projectSetup(repository.id);
    const command = kept?.command ?? null;
    const shell = kept?.shellKind ?? null;
    if (command !== null && shell !== null) {
      return { spec: { form: 'shell', shell, command }, source: 'configured', command };
    }
    const detection = await this.#detect(tree, repository);
    if (detection.kind === 'suggested') {
      const { manager, command, args } = detection.spec;
      return { spec: { form: 'argv', executable: manager, args }, source: 'detected', command };
    }
    return { spec: { form: 'none' }, source: 'none', command: null, why: reasonOf(detection) };
  }

  /**
   * The fixed table's suggestion for the files at the root of the workspace's base commit, read
   * from the picked checkout's repository: never a file's command, only which lockfiles are there.
   */
  async #detect(tree: WorktreeRecord, repository: RepositoryRecord): Promise<SetupDetection> {
    const { stdout } = await this.#deps.git.run({
      cwd: repository.realRoot,
      args: ['ls-tree', '-z', '--end-of-options', tree.baseOid],
    });
    const blobs = new Map<string, string>();
    for (const entry of stdout.split('\0')) {
      const fields = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(entry);
      if (fields?.[2] !== undefined && fields[3] !== undefined) blobs.set(fields[3], fields[2]);
    }
    const metadata = blobs.get('package.json');
    let packageJson: string | undefined;
    if (metadata !== undefined) {
      try {
        packageJson = (
          await this.#deps.git.run({
            cwd: repository.realRoot,
            args: ['cat-file', 'blob', metadata],
            maxBytes: MAX_PACKAGE_JSON,
          })
        ).stdout;
      } catch (error) {
        if (!(error instanceof GitError) || error.fault !== 'output') throw error;
        packageJson = '';
      }
    }
    return detectSetup({
      files: [...blobs.keys()],
      ...(packageJson === undefined ? {} : { packageJson }),
    });
  }

  // `project.setSetupCommand`.

  /**
   * The canvas's picked repository, kept: refused (saying why) for a canvas with no project folder
   * or one that isn't a repository it can make worktrees of.
   */
  async #repositoryOf(canvas: CanvasId): Promise<RepositoryRecord> {
    const { provisioner, directories } = this.#deps;
    const picked = directories.projectRoot(canvas);
    if (picked === undefined) {
      throw new SetupError(
        'refused',
        'Choose a project folder for this canvas first: a setup command is kept for its repository.',
      );
    }
    const found = await provisioner.repository(picked);
    if (found.kind === 'not-git') {
      throw new SetupError(
        'refused',
        'The project folder isn’t a Git repository: its agents share it, so there is no worktree to set up.',
      );
    }
    if (found.kind === 'refused') throw new SetupError('refused', found.sentence);
    return found.record;
  }

  async setCommand(
    canvas: CanvasId,
    command: string | null,
  ): Promise<{ changed: boolean; offered: number }> {
    const { workspaces } = this.#deps;
    if (command !== null) checkCommand(command);
    if (this.#closing) throw new SetupError('unavailable', 'corrallm is closing.');
    const repository = await this.#repositoryOf(canvas);
    const shell: ShellKind | null = command === null ? null : this.#windows ? 'windows' : 'posix';
    // What each setup still waiting would offer now, worked out before the write.
    const plans: { tree: WorktreeRecord; setup: SetupRecord; offer: Offer }[] = [];
    for (const tree of workspaces.worktreesIn(['setup'])) {
      if (tree.repository !== repository.id) continue;
      const setup = workspaces.setup(tree.id);
      if (setup === undefined || !DECIDABLE.includes(setup.state)) continue;
      const offer: Offer =
        command !== null && shell !== null
          ? { spec: { form: 'shell', shell, command }, source: 'configured', command }
          : await this.#detect(tree, repository).then((detection): Offer => {
              if (detection.kind === 'suggested') {
                const { manager, command: shown, args } = detection.spec;
                return {
                  spec: { form: 'argv', executable: manager, args },
                  source: 'detected',
                  command: shown,
                };
              }
              return {
                spec: { form: 'none' },
                source: 'none',
                command: null,
                why: reasonOf(detection),
              };
            });
      if (specHash(offer.spec) === setup.specHash && offer.source === setup.source) continue;
      plans.push({ tree, setup, offer });
    }
    const result = await workspaces
      .write((w) => {
        const before = w.projectSetup(repository.id);
        w.setProjectCommand(repository.id, command, shell);
        const changed =
          (before?.command ?? null) !== command || (before?.shellKind ?? null) !== shell;
        let offered = 0;
        for (const { tree, setup, offer } of plans) {
          const now = w.setup(tree.id);
          if (now?.generation !== setup.generation || !DECIDABLE.includes(now.state)) continue;
          w.offerSetup(tree.id, {
            command: offer.command,
            source: offer.source,
            specHash: specHash(offer.spec),
            copyManifestHash: now.copyManifestHash,
          });
          offered += 1;
        }
        return { changed, offered };
      })
      .catch((error: unknown) => {
        if (error instanceof WorkspaceStoreError && error.code === 'invalid') {
          throw new SetupError('invalid', error.message);
        }
        throw error;
      });
    for (const { tree, offer } of plans) {
      if (offer.why === undefined) this.#reasons.delete(tree.id);
      else this.#reasons.set(tree.id, offer.why);
    }
    for (const affected of new Set(plans.map(({ tree }) => tree.canvas))) this.#changed(affected);
    return result;
  }

  /**
   * Nothing runs by itself in the repository's new workspaces any more: each asks again. What
   * runs already goes on; a setup waiting keeps its card as it is.
   */
  async clearAlways(canvas: CanvasId): Promise<{ cleared: boolean }> {
    const repository = await this.#repositoryOf(canvas);
    return this.#deps.workspaces.write((w) => {
      if ((w.projectSetup(repository.id)?.alwaysSpecHash ?? null) === null) {
        return { cleared: false };
      }
      w.setAlways(repository.id, null);
      return { cleared: true };
    });
  }

  // Its card.

  items(canvas: CanvasId): NeedsItem[] {
    const items: NeedsItem[] = [];
    for (const tree of this.#deps.workspaces.worktreesOf(canvas)) {
      if (tree.state !== 'setup') continue;
      const setup = this.#deps.workspaces.setup(tree.id);
      if (setup === undefined || setup.state === 'done' || setup.state === 'skipped') continue;
      items.push(this.#card(tree, setup));
    }
    return items;
  }

  #card(tree: WorktreeRecord, setup: SetupRecord): NeedsItem {
    const names = this.#members(tree);
    const whose =
      names.length === 1
        ? `${names[0] ?? ''}’s worktree`
        : `the worktree ${names.join(', ')} share`;
    const lines: string[] = [];
    const exit = this.#exits.get(tree.id);
    const title =
      setup.state === 'running'
        ? `Setting up ${whose}`
        : setup.state === 'failed'
          ? `Setup failed in ${whose}`
          : setup.state === 'interrupted'
            ? `Setup was interrupted in ${whose}`
            : setup.command === null
              ? `No setup command for ${whose}`
              : `Set up ${whose}?`;
    if (setup.command === null) {
      const why = this.#reasons.get(tree.id);
      lines.push(
        `No setup command was found for it${why === undefined ? '' : ` (${why})`}. Set one for this repository in its project settings, or Skip: its agents then set it up themselves, as their permissions allow.`,
      );
    } else {
      lines.push(`Runs: ${setup.command}`);
      lines.push(
        setup.source === 'configured'
          ? 'From: the command you set for this repository, run by the system shell.'
          : 'From: the lockfile at the worktree’s base commit (corrallm’s fixed table), run without a shell.',
      );
    }
    lines.push(`In: ${tree.path}, on ${tree.branchRef.slice('refs/heads/'.length)}`);
    const copied = this.#quietly(() => this.#copyRecord(tree.id));
    lines.push(
      copied === undefined || copied.files.length === 0
        ? 'Copied in: no local files.'
        : `Copied in: ${copied.files.map((file) => file.path).join(', ')}.`,
    );
    if (setup.command !== null) {
      lines.push(
        'Installing dependencies can run the project’s and its packages’ own scripts, and use the network.',
      );
    }
    if (setup.state === 'failed') {
      lines.push(
        exit?.endedBy === 'stop'
          ? 'It was stopped.'
          : exit?.endedBy === 'timeout'
            ? 'It took too long, and was stopped.'
            : exit?.error !== undefined
              ? `It couldn’t start: ${exit.error}`
              : setup.exitCode === null
                ? 'It didn’t finish: it was stopped, or couldn’t start.'
                : `It exited with ${String(setup.exitCode)}.`,
      );
    }
    if (setup.state === 'interrupted') {
      lines.push(
        'corrallm stopped while it ran (it was interrupted), so whether it finished is unknown: it never runs again by itself.',
      );
    }
    if (this.#windows && setup.command !== null) lines.push(WINDOWS);
    const output = this.#quietly(() => this.#output(tree.id, setup)) ?? '';
    if (output !== '') lines.push('', output);
    return {
      id: setupNeedId(tree.id, setup.generation),
      canvas: tree.canvas,
      kind: 'worktree',
      for: 'you',
      by: ['you'],
      title,
      detail: lines.join('\n'),
      choices: this.#choices(setup).map((value) => CHOICES[value]),
      answerIn: 'api',
    };
  }

  /** What a card shows of the files beside the database: none, rather than no card, if unreadable. */
  #quietly<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      console.error('Could not read a worktree setup’s files:', error);
      return undefined;
    }
  }

  #choices(setup: SetupRecord): SetupChoice[] {
    const runs = setup.command !== null && !this.#windows;
    switch (setup.state) {
      case 'pending':
        return runs ? ['run', 'always', 'skip'] : ['skip'];
      case 'running':
        return ['stop'];
      case 'failed':
      case 'interrupted':
        return runs ? ['retry', 'skip'] : ['skip'];
      default:
        return [];
    }
  }

  #members(tree: WorktreeRecord): readonly string[] {
    const named = this.#deps.members?.(tree);
    if (named !== undefined && named.length > 0) return named;
    const bound = this.#deps.workspaces.bindingsTo(tree.canvas, tree.id).map(({ agent }) => agent);
    return bound.length > 0 ? bound : [tree.owner.slice(tree.owner.indexOf('/') + 1)];
  }

  /** The last of its output, escaped: from the attempt running, or its log. */
  #output(workspace: string, setup: SetupRecord): string {
    const attempt = this.#attempts.get(workspace);
    if (attempt?.process !== undefined) return escaped(attempt.process.tail());
    if (setup.logKey === null || setup.state === 'running') return '';
    let tail = this.#tails.get(setup.logKey);
    if (tail === undefined) {
      tail = readTail(path.join(this.#folder('logs'), `${setup.logKey}.log`));
      this.#tails.set(setup.logKey, tail);
    }
    return escaped(tail);
  }

  // Answering it.

  gone(canvas: CanvasId, to: string): SetupError | undefined {
    const named = NEED.exec(to);
    const tree = named?.[1] === undefined ? undefined : this.#deps.workspaces.worktree(named[1]);
    const setup = tree === undefined ? undefined : this.#deps.workspaces.setup(tree.id);
    if (tree?.canvas !== canvas || setup === undefined) return undefined;
    if (Number(named?.[2]) !== setup.generation) {
      return new SetupError(
        'conflict',
        `${to} is out of date: what it would run changed, so its setup was offered again. Answer its new card.`,
      );
    }
    if (setup.state === 'done' || setup.state === 'skipped') {
      return new SetupError(
        'conflict',
        `${to} is settled already: its setup was ${setup.state === 'done' ? 'done' : 'skipped'}.`,
      );
    }
    return undefined;
  }

  async reply(
    canvas: CanvasId,
    to: string,
    choice: string,
    by: PartyId,
    call?: SetupCall,
  ): Promise<{ outcome: SetupOutcome }> {
    const { workspaces } = this.#deps;
    // Yours alone, whoever claims otherwise: the registry's R3 refuses a token first.
    if (by !== 'you') {
      throw new SetupError('refused', `Only the user decides what runs in a worktree: ${to}.`);
    }
    const named = NEED.exec(to);
    const tree = named?.[1] === undefined ? undefined : workspaces.worktree(named[1]);
    const setup = tree === undefined ? undefined : workspaces.setup(tree.id);
    if (tree?.canvas !== canvas || setup === undefined) {
      throw new SetupError('not-found', `There is no Needs item ${to} on this canvas.`);
    }
    if (Number(named?.[2]) !== setup.generation) {
      throw new SetupError(
        'conflict',
        `${to} is out of date: what it would run changed, so its setup was offered again. Answer its new card.`,
      );
    }
    const offered = this.#choices(setup);
    if (!(offered as string[]).includes(choice)) {
      if (setup.state === 'done' || setup.state === 'skipped') {
        throw new SetupError(
          'conflict',
          `${to} is settled already: its setup was ${setup.state === 'done' ? 'done' : 'skipped'}.`,
        );
      }
      if (this.#windows && ['run', 'always', 'retry'].includes(choice)) {
        throw new SetupError('unavailable', WINDOWS);
      }
      throw new SetupError(
        'invalid',
        `${to} takes ${offered.map((value) => `"${value}"`).join(' or ')}, not "${choice}".`,
      );
    }
    if (choice === 'skip') return this.#skip(tree, setup, call);
    if (choice === 'stop') {
      call?.noReturn();
      return this.#stop(tree, setup);
    }
    if (tree.state !== 'setup') {
      throw new SetupError(
        'conflict',
        `Its worktree is ${tree.state} now, not waiting for its setup: try it again first.`,
      );
    }
    return this.#start(tree, setup, choice === 'always', call);
  }

  async #skip(
    tree: WorktreeRecord,
    setup: SetupRecord,
    call?: SetupCall,
  ): Promise<{ outcome: 'skipped' }> {
    await this.#deps.workspaces
      .write((w) => {
        call?.noReturn();
        w.skipSetup(tree.id, setup.generation);
        if (w.worktree(tree.id)?.state === 'setup') {
          w.transition(tree.id, { from: 'setup', to: 'ready' });
        }
      })
      .catch(stale);
    this.#changed(tree.canvas);
    return { outcome: 'skipped' };
  }

  async #stop(tree: WorktreeRecord, setup: SetupRecord): Promise<{ outcome: 'stopped' }> {
    const attempt = this.#attempts.get(tree.id);
    if (attempt?.generation === setup.generation) {
      attempt.endedBy ??= 'stop';
      attempt.wake?.();
      await attempt.process?.stop('stop');
      await attempt.done;
    } else {
      // Nothing of this core's runs it (none can, but a record says so): ended as it stands.
      await this.#deps.workspaces
        .write((w) => w.finishSetup(tree.id, setup.generation, null))
        .catch(stale);
      this.#changed(tree.canvas);
    }
    return { outcome: 'stopped' };
  }

  async #start(
    tree: WorktreeRecord,
    setup: SetupRecord,
    always: boolean,
    call?: SetupCall,
  ): Promise<{ outcome: 'started' }> {
    const { workspaces, provisioner } = this.#deps;
    if (this.#closing) throw new SetupError('unavailable', 'corrallm is closing.');
    const repository = workspaces.repository(tree.repository);
    if (repository === undefined) {
      throw new SetupError('not-found', 'Its repository isn’t kept any more.');
    }
    // What runs is what the card showed: matched again against what may run now.
    const spec = this.#runSpec(setup, repository);
    const checkout = await provisioner.checkout(tree.id);
    if (checkout.state !== 'setup') {
      throw new SetupError(
        'conflict',
        `Its worktree isn’t there as it was made (${checkout.state === 'held' ? checkout.reason : checkout.state}): try it again first.`,
      );
    }
    // Your approval, and the attempt, on disk before anything runs.
    const started = await workspaces
      .write((w) => {
        call?.noReturn();
        if (always) w.setAlways(repository.id, setup.specHash);
        return w.startSetup(tree.id, {
          generation: setup.generation,
          by: 'you',
          logKey: logKey(setup),
        });
      })
      .catch(stale);
    this.#launch(tree, started, spec);
    this.#changed(tree.canvas);
    return { outcome: 'started' };
  }

  /** What may run for a setup offered: the table's or yours as it is now, hashing as offered. */
  #runSpec(setup: SetupRecord, repository: RepositoryRecord): RunSpec {
    let spec: RunSpec | undefined;
    if (setup.source === 'detected') {
      const manager = (Object.keys(SUGGESTED_COMMANDS) as (keyof typeof SUGGESTED_COMMANDS)[]).find(
        (name) => SUGGESTED_COMMANDS[name].command === setup.command,
      );
      if (manager !== undefined) {
        spec = { form: 'argv', executable: manager, args: SUGGESTED_COMMANDS[manager].args };
      }
    } else if (setup.source === 'configured') {
      const kept = this.#deps.workspaces.projectSetup(repository.id);
      if (
        kept !== undefined &&
        kept.command !== null &&
        kept.command === setup.command &&
        kept.shellKind !== null
      ) {
        spec = { form: 'shell', shell: kept.shellKind, command: kept.command };
      }
    }
    if (spec === undefined || specHash(spec) !== setup.specHash) {
      throw new SetupError(
        'conflict',
        'What it would run changed since it was offered: answer its new card.',
      );
    }
    return spec;
  }

  // Running it.

  #launch(tree: WorktreeRecord, setup: SetupRecord, spec: RunSpec): void {
    const attempt: Attempt = {
      canvas: tree.canvas,
      workspace: tree.id,
      generation: setup.generation,
      done: Promise.resolve(),
    };
    this.#attempts.set(tree.id, attempt);
    this.#exits.delete(tree.id);
    attempt.done = this.#run(attempt, setup, spec)
      .catch((error: unknown) => {
        console.error('Could not record a worktree setup’s end:', error);
      })
      .finally(() => {
        if (this.#attempts.get(tree.id) === attempt) this.#attempts.delete(tree.id);
        this.#changed(tree.canvas);
      });
  }

  async #run(attempt: Attempt, setup: SetupRecord, spec: RunSpec): Promise<void> {
    // False: woken without a slot, stopped while it waited, so nothing runs.
    const slotted = await this.#slot(attempt);
    let exit: SetupExit;
    try {
      exit = slotted
        ? await this.#execute(attempt, setup, spec)
        : { code: null, signal: null, endedBy: attempt.endedBy ?? 'shutdown' };
    } catch (error) {
      const endedBy = endedOf(attempt);
      exit = {
        code: null,
        signal: null,
        error: (error as Error).message,
        ...(endedBy === undefined ? {} : { endedBy }),
      };
    } finally {
      if (slotted) this.#release();
    }
    this.#exits.set(attempt.workspace, exit);
    const { workspace, generation } = attempt;
    await this.#deps.workspaces.write((w) => {
      if (exit.endedBy === 'shutdown') {
        w.interruptSetup(workspace, generation);
        return;
      }
      const ended = w.finishSetup(
        workspace,
        generation,
        exit.endedBy === undefined && exit.error === undefined && exit.signal === null
          ? exit.code
          : null,
      );
      if (ended.state === 'done' && w.worktree(workspace)?.state === 'setup') {
        w.transition(workspace, { from: 'setup', to: 'ready' });
      }
    });
  }

  async #execute(attempt: Attempt, setup: SetupRecord, spec: RunSpec): Promise<SetupExit> {
    if (attempt.endedBy !== undefined || this.#closing) {
      return { code: null, signal: null, endedBy: attempt.endedBy ?? 'shutdown' };
    }
    if (this.#windows) return { code: null, signal: null, error: WINDOWS };
    const env = await this.#deps.environment();
    const cancelled = endedOf(attempt);
    if (cancelled !== undefined) return { code: null, signal: null, endedBy: cancelled };
    // Verified again just before it runs: never in a checkout that isn't the one made.
    const checkout = await this.#deps.provisioner.checkout(attempt.workspace);
    if (checkout.state !== 'setup') {
      return { code: null, signal: null, error: 'its worktree isn’t there as it was made.' };
    }
    const { executable, args } = launchOf(spec, env);
    const logs = this.#folder('logs');
    const key = setup.logKey ?? logKey(setup);
    // Only its latest attempt's log is kept.
    for (const old of readdirSync(logs)) {
      if (old.startsWith(`${attempt.workspace}.`)) rmSync(path.join(logs, old), { force: true });
    }
    const running = await SetupProcess.start(
      {
        // Opening the private log is asynchronous too. Stop can arrive during that await: refuse
        // at the actual spawn boundary, before any instruction of an approved command can run.
        run: (work) => {
          if (endedOf(attempt) !== undefined || this.#closing) {
            throw new SetupError('unavailable', 'The setup was stopped before it started.');
          }
          return this.#deps.processes.run(work);
        },
        stop: (child, signal) => this.#deps.processes.stop(child, signal),
      },
      {
        executable,
        args,
        cwd: checkout.cwd,
        env,
        log: path.join(logs, `${key}.log`),
        timeoutMs: this.#deps.timeoutMs ?? TIMEOUT_MS,
      },
    );
    attempt.process = running;
    this.#changed(attempt.canvas);
    // Stopped while it was being started: ended at once.
    const ended = endedOf(attempt);
    if (ended !== undefined) void running.stop(ended);
    return running.exited;
  }

  /** A slot of `maxRunning`, once one is free: true, or false if it was woken without one. */
  async #slot(attempt: Attempt): Promise<boolean> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return true;
    }
    const slotted = await new Promise<boolean>((resolve) => {
      const waiter = (granted: boolean) => {
        delete attempt.wake;
        resolve(granted);
      };
      this.#waiting.push(waiter);
      attempt.wake = () => {
        const at = this.#waiting.indexOf(waiter);
        if (at >= 0) this.#waiting.splice(at, 1);
        waiter(false);
      };
    });
    return slotted;
  }

  /** A slot freed: the next waiting takes it, or it is free. */
  #release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next(true);
    else this.#active -= 1;
  }

  // As the core closes.

  async close(): Promise<void> {
    this.#closing = true;
    const attempts = [...this.#attempts.values()];
    for (const attempt of attempts) {
      attempt.endedBy ??= 'shutdown';
      attempt.wake?.();
      void attempt.process?.stop('shutdown');
    }
    await Promise.all(attempts.map((attempt) => attempt.done));
    await Promise.allSettled([...this.#prepares.values()]);
  }

  // As its workspace is removed.

  running(workspace: string): boolean {
    return this.#attempts.has(workspace);
  }

  /**
   * The local files copied into the workspace, by name (its copy record): what a checkpoint never
   * commits (B9b Design §9 C6). None if its record isn't there or can't be read: unknown.
   */
  copied(workspace: string): readonly string[] | undefined {
    return this.#quietly(() => this.#copyRecord(workspace))?.files.map((file) => file.path);
  }

  jobs(): number {
    return this.#attempts.size;
  }

  async forget(workspace: string): Promise<void> {
    const attempt = this.#attempts.get(workspace);
    if (attempt !== undefined) {
      attempt.endedBy ??= 'stop';
      attempt.wake?.();
      await attempt.process?.stop('stop');
      await attempt.done;
    }
    const logs = this.#folder('logs');
    for (const old of readdirSync(logs)) {
      if (old.startsWith(`${workspace}.`)) rmSync(path.join(logs, old), { force: true });
    }
    rmSync(path.join(this.#folder('copies'), `${workspace}.json`), { force: true });
    this.#copies.delete(workspace);
    this.#exits.delete(workspace);
    this.#reasons.delete(workspace);
    for (const key of [...this.#tails.keys()]) {
      if (key.startsWith(`${workspace}.`)) this.#tails.delete(key);
    }
  }

  // Its private folder.

  #folder(name: 'logs' | 'copies'): string {
    const root = this.#deps.folder;
    const at = path.join(root, name);
    for (const folder of [root, at]) privateFolder(folder);
    return at;
  }

  #copyRecord(workspace: string): CopyRecord | undefined {
    const cached = this.#copies.get(workspace);
    if (cached !== undefined) return cached;
    const file = path.join(this.#folder('copies'), `${workspace}.json`);
    const text = readSmall(file, MAX_RECORD_BYTES);
    if (text === undefined) return undefined;
    const record = copyRecordOf(text);
    if (record !== undefined) this.#copies.set(workspace, record);
    return record;
  }

  /** What was copied, kept (names, sizes and hashes) once all of it is: never copied twice. */
  #keepCopyRecord(workspace: string, record: CopyRecord): void {
    const folder = this.#folder('copies');
    const file = path.join(folder, `${workspace}.json`);
    const partial = `${file}.${randomUUID()}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      const fd = openSync(partial, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(partial, file);
      if (process.platform !== 'win32') {
        const dir = openSync(folder, 'r');
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } finally {
      rmSync(partial, { force: true });
    }
    this.#copies.set(workspace, record);
  }

  #changed(canvas: CanvasId): void {
    try {
      this.#deps.changed?.(canvas);
    } catch (error) {
      console.error('Could not tell of a worktree setup’s change:', error);
    }
  }
}

const CHOICES: Readonly<Record<SetupChoice, NeedChoice>> = {
  run: {
    value: 'run',
    label: 'Run',
    description: 'Run it once, in this worktree.',
    humanOnly: YOURS,
  },
  always: {
    value: 'always',
    label: 'Always for this repository',
    description:
      'Run it now, and run exactly this command by itself in this repository’s new worktrees from now on.',
    humanOnly: YOURS,
  },
  skip: {
    value: 'skip',
    label: 'Skip',
    description: 'Start its agents without it.',
    humanOnly: YOURS,
  },
  stop: {
    value: 'stop',
    label: 'Stop',
    description: 'End it and every process it started.',
    humanOnly: YOURS,
  },
  retry: {
    value: 'retry',
    label: 'Run again',
    description: 'Run it again, as a new attempt.',
    humanOnly: YOURS,
  },
};

/** Refuses a command you set that isn't one line of plain text of at most 4 KiB. */
function checkCommand(command: string): void {
  if (
    command.trim() === '' ||
    Buffer.byteLength(command, 'utf8') > MAX_SETUP_COMMAND_BYTES ||
    UNSEEN_IN_COMMAND.test(command)
  ) {
    throw new SetupError(
      'invalid',
      'A setup command is one line of text, with no control or invisible characters, at most 4 KiB.',
    );
  }
}

/** A store's stale or refused write: the card moved on meanwhile. */
function stale(error: unknown): never {
  if (
    error instanceof WorkspaceStoreError &&
    (error.code === 'stale' || error.code === 'refused')
  ) {
    throw new SetupError('conflict', `It changed meanwhile: ${error.message}`);
  }
  throw error;
}

/** Why an attempt was ended, read as it is now (it changes while the attempt is awaited). */
function endedOf(attempt: Attempt): Attempt['endedBy'] {
  return attempt.endedBy;
}

function logKey(setup: SetupRecord): string {
  return `${setup.workspace}.${String(setup.generation)}.${randomUUID().slice(0, 8)}`;
}

/** The executable and arguments that run a spec: the table's on the agents' PATH, or the shell. */
function launchOf(
  spec: RunSpec,
  env: Readonly<Record<string, string>>,
): { executable: string; args: readonly string[] } {
  if (spec.form === 'argv') {
    const found = findExecutable(env, spec.executable);
    if (found === undefined) {
      throw new Error(`${spec.executable} isn’t installed where the agents would find it.`);
    }
    return { executable: found, args: spec.args };
  }
  if (spec.form === 'shell' && spec.shell === 'posix') {
    return { executable: '/bin/sh', args: ['-c', spec.command] };
  }
  throw new Error('There is nothing it may run.');
}

/** An executable in the PATH's absolute folders only: a relative entry could find a repository's. */
function findExecutable(env: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const folder of (env.PATH ?? '').split(':')) {
    if (!path.isAbsolute(folder)) continue;
    const file = path.join(folder, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

function reasonOf(detection: Extract<SetupDetection, { kind: 'manual' }>): string {
  switch (detection.reason) {
    case 'no-lockfile':
      return 'no lockfile corrallm knows';
    case 'multiple-managers':
      return `lockfiles of ${detection.managers.join(' and ')}`;
    case 'unsupported-manager':
      return `${detection.managers.join(', ')} isn’t one corrallm runs by itself yet`;
    case 'missing-package-json':
      return 'a lockfile without a package.json';
    case 'invalid-package-json':
      return 'its package.json can’t be read';
    case 'conflicting-package-manager':
      return 'its package.json names another package manager';
  }
}

/** Its last lines, as plain text: escape sequences, control and invisible characters removed. */
export function escaped(text: string): string {
  const plain = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (found) => (found === '\n' ? found : ''));
  const lines = plain.replace(/\n+$/, '').split('\n').slice(-MAX_SHOWN_LINES).join('\n');
  return lines.length > MAX_SHOWN_CHARS ? `…${lines.slice(-MAX_SHOWN_CHARS)}` : lines;
}

/** A folder of the core's own: a real one, the user's, private. Made if it is missing. */
function privateFolder(at: string): void {
  mkdirSync(at, { recursive: true, mode: 0o700 });
  const found = lstatSync(at);
  if (found.isSymbolicLink() || !found.isDirectory()) {
    throw new Error(`${at} isn’t a folder of corrallm’s own.`);
  }
  if (process.platform !== 'win32') {
    if (found.uid !== process.getuid?.()) throw new Error(`${at} isn’t the user’s.`);
    if ((found.mode & 0o077) !== 0) throw new Error(`${at} may be read by others.`);
  }
}

/** A small regular file's text, never through a symlink; none if there is none. */
function readSmall(file: string, max: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > max) return undefined;
    const bytes = Buffer.alloc(stats.size);
    readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The end of a log, never through a symlink. */
function readTail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return '';
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return '';
    const length = Math.min(stats.size, MAX_TAIL_READ);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, stats.size - length);
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** A copy record as it was written; none if it isn't one (then the copy is made again). */
function copyRecordOf(text: string): CopyRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<CopyRecord>;
    if (
      (value.manifest === null || typeof value.manifest === 'string') &&
      Array.isArray(value.files) &&
      value.files.every(
        (file) =>
          typeof file.path === 'string' &&
          typeof file.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(file.sha256) &&
          Number.isSafeInteger(file.bytes),
      ) &&
      typeof value.bytes === 'number' &&
      typeof value.hash === 'string' &&
      /^[0-9a-f]{64}$/.test(value.hash)
    ) {
      return value as CopyRecord;
    }
  } catch {
    // Not one.
  }
  return undefined;
}
