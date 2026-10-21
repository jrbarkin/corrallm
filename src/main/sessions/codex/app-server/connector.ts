import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { CodexMode, ModelChoice, SessionEvent } from '../../../../shared/session';
import type { UsageBackendId } from '../../../../shared/adapter';
import type { UsageWindows } from '../../../../shared/usage';
import { CODEX_TERMINAL, CODEX_USAGE } from '../adapter';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../../connector';
import { displayPath, notice, property, text } from '../../transcript';
import type { Places } from '../../transcript';
import { checkVersion, requireCodex } from '../codex';
import { appServerRefusal, ASK_EACH_SESSION, codexLogin } from '../login';
import type { Distribution, Consent } from '../../adapter';
import { startAppServer } from '../rpc';
import type { SpawnAppServer } from '../rpc';
import { folderTrust } from '../terminal/hooks';
import { readSkills, slashCommands } from './commands';
import { runGit } from './diff';
import type { RunGit } from './diff';
import { appendRole, readDeveloperInstructions } from './instructions';
import { Prompts } from './prompts';
import { modeSettings } from './protocol';
import { AppServerSession, readModels, resumedHistory } from './session';
import type { CodexModel, ThreadInfo } from './session';
import { Translator } from './translate';

/*
 * The App Server connection: a Codex agent runs as a real Codex thread, through `codex app-server`
 * (JSON-RPC over stdio; ../rpc.ts), shown in corrallm's own transcript and composer, as a Claude
 * agent's Agent SDK connection is. It runs the user's own `codex` (../codex.ts) in the project
 * folder, so the thread has their version, login and settings (~/.codex: config.toml, AGENTS.md,
 * skills, MCP servers), and is theirs: `codex resume` sees it, and corrallm resumes it after a
 * restart. One private app server per session, closed with it, told on its command line that the
 * project folder is trusted (the user chose it in corrallm's folder dialog, the trust gate), for
 * that server alone, as a Codex Terminal session is: their config.toml is never written.
 *
 * It runs on whatever login Codex has; on a ChatGPT plan only once the user allows it, and never in
 * a build made as a commercial or hosted product (../login.ts says why). The plan's usage limits
 * (read as it connects, then as Codex tells them: ../limits.ts) go to main's usage readings, unasked:
 * reading them uses no model.
 */

export interface AppServerConnectorDeps {
  /** What Codex is told runs it ("corrallm/0.1.0"). */
  clientApp: string;
  /** Finds the `codex` to run, in the agents' environment. */
  findCodex?: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** Starts the app server's process (child_process.spawn; a fake in tests). */
  spawn?: SpawnAppServer;
  /** How this build is offered: only a local one runs on a ChatGPT login (login.ts). */
  distribution?: Distribution;
  /** The user's say on running on their ChatGPT plan, kept for good (main's settings). */
  consent?: Consent;
  /** Runs git for /diff, in the agents' environment. */
  git?: (env: Readonly<Record<string, string>>) => RunGit;
  home?: string;
  /** Takes the usage readings Codex reports (main's UsageReadings). */
  usage?: (backend: UsageBackendId, windows: UsageWindows) => void;
}

/** How many of a resumed thread's last turns its history shows. */
const HISTORY_TURNS = 30;
/** What Codex says when a thread to resume was never kept (it had no turn) or is gone. */
const NO_THREAD = /no rollout found|thread not found|not found/i;

export class AppServerConnector implements Connector<CodexMode> {
  readonly #clientApp: string;
  readonly #findCodex: (env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #spawn: SpawnAppServer | undefined;
  readonly #distribution: Distribution;
  readonly #consent: Consent;
  readonly #git: (env: Readonly<Record<string, string>>) => RunGit;
  readonly #home: string;
  readonly #usage: ((backend: UsageBackendId, windows: UsageWindows) => void) | undefined;

  constructor({
    clientApp,
    findCodex = (env) => requireCodex(env),
    spawn,
    distribution = 'local',
    consent = ASK_EACH_SESSION,
    git = runGit,
    home = homedir(),
    usage,
  }: AppServerConnectorDeps) {
    this.#clientApp = clientApp;
    this.#findCodex = findCodex;
    this.#spawn = spawn;
    this.#distribution = distribution;
    this.#consent = consent;
    this.#git = git;
    this.#home = home;
    this.#usage = usage;
  }

  async start(spec: SessionSpec<CodexMode>, host: SessionHost): Promise<LiveSession<CodexMode>> {
    const codex = await this.#findCodex(spec.env);
    const realCwd = await realpath(spec.cwd).catch(() => spec.cwd);
    const places: Places = {
      cwd: spec.cwd,
      home: this.#home,
      ...(realCwd === spec.cwd ? {} : { realCwd }),
    };
    const usage = this.#usage;
    const translator = new Translator({
      places,
      ...(usage === undefined
        ? {}
        : {
            usage: (windows: UsageWindows) => {
              usage(CODEX_USAGE, windows);
            },
          }),
    });
    // What the server says before the session runs waits for it (its thread starting, its MCP
    // servers), so that 'started' comes first.
    const early: { method: string; params: unknown }[] = [];
    const live: { session?: AppServerSession } = {};
    const prompts = new Prompts(
      {
        emit: (event) => {
          host.emit(event);
        },
        settled: () => live.session?.settled(),
        patch: (itemId) => translator.patch(itemId),
      },
      places,
    );
    const version = /\/(\S+)$/.exec(this.#clientApp)?.[1] ?? '0.0.0';
    const server = await startAppServer({
      codex,
      cwd: spec.cwd,
      env: spec.env,
      clientInfo: { name: 'corrallm', title: 'corrallm', version },
      // The project folder trusted for this server alone, as a Terminal session trusts it: by the
      // path its thread works in, and its real path where they differ (Codex may resolve it).
      args: ['-c', folderTrust(spec.cwd, realCwd)],
      onNotification: (method, params) => {
        if (live.session) live.session.notification(method, params);
        else early.push({ method, params });
      },
      onRequest: (method, params, id) => {
        host.activity?.();
        return prompts.request(method, params, id);
      },
      ...(this.#spawn === undefined ? {} : { spawn: this.#spawn }),
    });
    try {
      const old = server.version === undefined ? undefined : checkVersion(server.version);
      if (old !== undefined) throw new Error(old);
      const login = codexLogin(await server.request('account/read', { refreshToken: false }));
      const refused = appServerRefusal(login, this.#distribution);
      if (refused !== undefined) {
        host.emit({
          type: 'notice',
          id: randomUUID(),
          level: 'error',
          text: refused,
          switchTo: CODEX_TERMINAL,
        });
        throw new Error(refused);
      }
      const [listed, skilled, limits] = await Promise.all([
        server.request('model/list', { limit: 100 }).catch(() => undefined),
        server.request('skills/list', { cwds: [spec.cwd] }).catch(() => undefined),
        server.request('account/rateLimits/read', {}).catch(() => undefined),
      ]);
      const models = readModels(listed);
      const skills = readSkills(skilled);

      // Read native instructions for a current role, or restore them after a role was removed.
      // Codex 0.162.1 can retain old model-visible context:
      // https://github.com/openai/codex/issues/19045 (role edits need an explicit new conversation).
      // A thread with no role change keeps Codex's exact defaults.
      const developerInstructions =
        spec.role !== undefined || (spec.resume !== null && spec.roleChanged === true)
          ? appendRole(await readDeveloperInstructions(server, spec.cwd), spec.role)
          : undefined;
      const begin = (mode: CodexMode | null, model: string | null) => {
        const settings = mode === null ? undefined : modeSettings(mode);
        return {
          cwd: spec.cwd,
          ...(settings === undefined
            ? {}
            : { approvalPolicy: settings.approvalPolicy, sandbox: settings.sandbox }),
          ...(model === null ? {} : { model }),
          ...(developerInstructions === undefined ? {} : { developerInstructions }),
        };
      };
      const newThread = async (mode: CodexMode | null, model: string | null) =>
        threadInfo(
          await server.request('thread/start', { ...begin(mode, model), serviceName: 'corrallm' }),
          places,
        );
      const model =
        spec.model !== null && models.some((m) => m.value === spec.model) ? spec.model : null;
      const mode = spec.mode;
      let thread: ThreadInfo;
      let history: SessionEvent[] = [];
      const told: SessionEvent[] = [];
      if (spec.resume === null) {
        thread = await newThread(mode, model);
      } else {
        try {
          const resumed = await server.request('thread/resume', {
            ...begin(mode, model),
            threadId: spec.resume,
            excludeTurns: true,
            initialTurnsPage: { limit: HISTORY_TURNS, sortDirection: 'desc', itemsView: 'full' },
          });
          thread = threadInfo(resumed, places);
          history = resumedHistory(resumed, places);
        } catch (error) {
          // A thread never kept (it had no turn: one a Terminal session of the agent had before
          // its first message) or gone: a new one starts quietly. Otherwise the user is told.
          const message = error instanceof Error ? error.message : String(error);
          if (!NO_THREAD.test(message)) {
            told.push(
              notice(
                'warning',
                `The earlier chat could not be resumed, so this is a new one. ${message}`,
              ),
            );
          }
          thread = await newThread(mode, model);
        }
      }
      const effort =
        spec.effort != null && effortsOf(models, thread.model).includes(spec.effort)
          ? spec.effort
          : thread.effort;
      const session = new AppServerSession({
        server,
        host,
        translator,
        prompts,
        places,
        thread: { ...thread, effort },
        mode,
        models,
        skills,
        login,
        // On a ChatGPT plan, the session asks before it first uses it (unless allowed for good).
        ...(login.kind === 'chatgpt' ? { consent: this.#consent } : {}),
        git: this.#git(spec.env),
        newThread: (mode, current) => newThread(mode, current),
      });
      live.session = session;
      host.emit({
        type: 'started',
        model: thread.model,
        mode: session.mode,
        models: choices(models, thread.model),
        effort: session.effort,
        ...(session.asks === undefined ? {} : { asks: session.asks }),
      });
      host.emit({ type: 'commands', commands: slashCommands(skills) });
      if (history.length > 0) host.emit({ type: 'history', events: history });
      for (const event of [...told, ...translator.setLimits(property(limits, 'rateLimits'))]) {
        host.emit(event);
      }
      for (const { method, params } of early.splice(0)) session.notification(method, params);
      return session;
    } catch (error) {
      await server.close();
      throw error;
    }
  }
}

/** What thread/start or thread/resume said about the thread. */
function threadInfo(result: unknown, places: Places): ThreadInfo {
  const thread = property(result, 'thread');
  const id = text(property(thread, 'id'));
  if (id === undefined) throw new Error('Codex’s app server started no thread.');
  const sources = property(result, 'instructionSources');
  return {
    id,
    model: text(property(result, 'model')) ?? text(property(thread, 'model')) ?? '',
    effort: text(property(result, 'reasoningEffort')) ?? null,
    sandbox: property(result, 'sandbox'),
    approval: property(result, 'approvalPolicy'),
    instructions: Array.isArray(sources)
      ? sources.flatMap((file) => (typeof file === 'string' ? [displayPath(file, places)] : []))
      : [],
  };
}

/** The models the picker offers: Codex's, and the thread's own if it is not among them. */
function choices(models: readonly CodexModel[], current: string): ModelChoice[] {
  const listed = models.map(
    ({ value, label, description, efforts, defaultEffort }): ModelChoice => ({
      value,
      label,
      ...(description === undefined ? {} : { description }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    }),
  );
  return current === '' || listed.some((m) => m.value === current)
    ? listed
    : [...listed, { value: current, label: current }];
}

function effortsOf(models: readonly CodexModel[], model: string): string[] {
  return (models.find((m) => m.value === model)?.efforts ?? []).map((effort) => effort.value);
}
