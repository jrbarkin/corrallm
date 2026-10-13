import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { CodexMode, ModelChoice, SessionEvent } from '../../../../shared/session';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../../connector';
import { displayPath, notice, property, text } from '../../transcript';
import type { Places } from '../../transcript';
import { checkVersion, requireCodex } from '../codex';
import { appServerRefusal, codexLogin } from '../login';
import type { CodexLogin } from '../login';
import { startAppServer } from '../rpc';
import type { SpawnAppServer } from '../rpc';
import { readSkills, slashCommands } from './commands';
import { runGit } from './diff';
import type { RunGit } from './diff';
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
 * restart. One private app server per session, closed with it.
 *
 * It runs on an API key (or another provider's login), not a ChatGPT plan (../login.ts says why).
 */

export interface AppServerConnectorDeps {
  /** What Codex is told runs it ("corrallm/0.1.0"). */
  clientApp: string;
  /** Finds the `codex` to run, in the agents' environment. */
  findCodex?: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** Starts the app server's process (child_process.spawn; a fake in tests). */
  spawn?: SpawnAppServer;
  /** Why the connection does not run on a login, if it does not (login.ts). */
  refusal?: (login: CodexLogin) => string | undefined;
  /** Runs git for /diff, in the agents' environment. */
  git?: (env: Readonly<Record<string, string>>) => RunGit;
  home?: string;
}

/** How many of a resumed thread's last turns its history shows. */
const HISTORY_TURNS = 30;
/** What Codex says when a thread to resume was never kept (it had no turn) or is gone. */
const NO_THREAD = /no rollout found|thread not found|not found/i;

export class AppServerConnector implements Connector<CodexMode> {
  readonly #clientApp: string;
  readonly #findCodex: (env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #spawn: SpawnAppServer | undefined;
  readonly #refusal: (login: CodexLogin) => string | undefined;
  readonly #git: (env: Readonly<Record<string, string>>) => RunGit;
  readonly #home: string;

  constructor({
    clientApp,
    findCodex = (env) => requireCodex(env),
    spawn,
    refusal = appServerRefusal,
    git = runGit,
    home = homedir(),
  }: AppServerConnectorDeps) {
    this.#clientApp = clientApp;
    this.#findCodex = findCodex;
    this.#spawn = spawn;
    this.#refusal = refusal;
    this.#git = git;
    this.#home = home;
  }

  async start(spec: SessionSpec<CodexMode>, host: SessionHost): Promise<LiveSession<CodexMode>> {
    const codex = await this.#findCodex(spec.env);
    const realCwd = await realpath(spec.cwd).catch(() => spec.cwd);
    const places: Places = {
      cwd: spec.cwd,
      home: this.#home,
      ...(realCwd === spec.cwd ? {} : { realCwd }),
    };
    const translator = new Translator({ places });
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
      onNotification: (method, params) => {
        if (live.session) live.session.notification(method, params);
        else early.push({ method, params });
      },
      onRequest: prompts.request,
      ...(this.#spawn === undefined ? {} : { spawn: this.#spawn }),
    });
    try {
      const old = server.version === undefined ? undefined : checkVersion(server.version);
      if (old !== undefined) throw new Error(old);
      const login = codexLogin(await server.request('account/read', { refreshToken: false }));
      const refused = this.#refusal(login);
      if (refused !== undefined) throw new Error(refused);
      const [listed, skilled, limits] = await Promise.all([
        server.request('model/list', { limit: 100 }).catch(() => undefined),
        server.request('skills/list', { cwds: [spec.cwd] }).catch(() => undefined),
        server.request('account/rateLimits/read', {}).catch(() => undefined),
      ]);
      const models = readModels(listed);
      const skills = readSkills(skilled);

      const begin = (mode: CodexMode, model: string | null) => {
        const settings = modeSettings(mode);
        return {
          cwd: spec.cwd,
          approvalPolicy: settings.approvalPolicy,
          sandbox: settings.sandbox,
          ...(model === null ? {} : { model }),
        };
      };
      const newThread = async (mode: CodexMode, model: string | null) =>
        threadInfo(
          await server.request('thread/start', { ...begin(mode, model), serviceName: 'corrallm' }),
          places,
        );
      const model =
        spec.model !== null && models.some((m) => m.value === spec.model) ? spec.model : null;
      let thread: ThreadInfo;
      let history: SessionEvent[] = [];
      const told: SessionEvent[] = [];
      if (spec.resume === null) {
        thread = await newThread(spec.mode, model);
      } else {
        try {
          const resumed = await server.request('thread/resume', {
            ...begin(spec.mode, model),
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
          thread = await newThread(spec.mode, model);
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
        mode: spec.mode,
        models,
        skills,
        login,
        git: this.#git(spec.env),
        newThread: (mode, current) => newThread(mode, current),
      });
      live.session = session;
      host.emit({
        type: 'started',
        model: thread.model,
        mode: spec.mode,
        models: choices(models, thread.model),
        effort: session.effort,
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
