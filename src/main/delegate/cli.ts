import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs as parseOptions } from 'node:util';

import { EFFORT_PATTERN, MODEL_PATTERN } from '../../shared/session';
import type { SettingsOptions } from '../../shared/session';
import { AppServerConnector } from '../sessions/codex/app-server/connector';
import { runGit } from '../sessions/codex/app-server/diff';
import { requireCodex } from '../sessions/codex/codex';
import { ASK_EACH_SESSION } from '../sessions/codex/login';
import type { PlanConsent } from '../sessions/codex/login';
import { codexOptions } from '../sessions/codex/options';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { isSessionId } from '../sessions/id';
import { delegate } from './delegate';
import type { Delegation, Task } from './delegate';

/*
 * The `delegate` command (pnpm delegate -- …): hands a task to Codex from a terminal, or from an
 * agent such as Claude Code, as one turn of a Codex thread (delegate.ts), and prints how it went:
 * what Codex did as it goes, on stderr; a report in Markdown at the end, on stdout. It exits 0 if the
 * turn completed, 1 if it failed, 2 if Codex stopped to ask something, 3 if it was stopped or ran
 * out of time.
 */

export const USAGE = `Usage: pnpm delegate -- --cwd <folder> [options] <task…>

Hands a task to Codex, as one turn of a Codex thread run in <folder>, in Codex's
sandbox: it writes only there, and stops to ask before leaving it.

  --cwd <folder>      Where Codex works (a git worktree of its own, best)
  --file <path>       Read the task from a file instead
  --resume <thread>   Continue that thread (the report says its id)
  --model <id>        A model --models lists (default: the user's own)
  --effort <level>    A reasoning effort the model offers
  --read-only         Codex may read but not write
  --yes               Approve what Codex asks to run or change, rather than stop
  --chatgpt-plan      Let Codex's app server use your ChatGPT plan
  --timeout <min>     Interrupt the turn after this many minutes (default 60)
  --models            List Codex's models and efforts, and exit
`;

/** What the command was asked to do. */
export type Command =
  | { kind: 'help' }
  | { kind: 'models'; cwd: string }
  | ({ kind: 'task'; cwd: string; file: string | null; chatgptPlan: boolean } & Omit<
      Task,
      'cwd' | 'env'
    >);

/** A mistake in how the command was run: it is told, with how to run it. */
export class UsageError extends Error {}

const MAX_TASK = 100_000;
const MAX_MINUTES = 24 * 60;

/** What `args` ask for; throws a UsageError saying what is wrong with them. */
export function parseArgs(args: readonly string[]): Command {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseOptions({
      // pnpm passes on the `--` that comes before the command's own arguments.
      args: args[0] === '--' ? args.slice(1) : [...args],
      strict: true,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        file: { type: 'string' },
        resume: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        'read-only': { type: 'boolean' },
        yes: { type: 'boolean' },
        'chatgpt-plan': { type: 'boolean' },
        timeout: { type: 'string' },
        models: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) return { kind: 'help' };
  const cwd = values.cwd;
  if (cwd === undefined || cwd === '') throw new UsageError('Say where Codex works, with --cwd.');
  if (values.models) return { kind: 'models', cwd };
  const text = positionals.join(' ').trim();
  const file = values.file ?? null;
  if ((text === '') === (file === null)) {
    throw new UsageError('Give the task in words, or with --file: one of them.');
  }
  if (text.length > MAX_TASK) throw new UsageError('That task is too long.');
  const resume = values.resume ?? null;
  if (resume !== null && !isSessionId(resume)) {
    throw new UsageError('--resume takes a Codex thread id.');
  }
  const model = values.model ?? null;
  if (model !== null && !MODEL_PATTERN.test(model)) {
    throw new UsageError(`${model} is not a model's name.`);
  }
  const effort = values.effort ?? null;
  if (effort !== null && !EFFORT_PATTERN.test(effort)) {
    throw new UsageError(`${effort} is not a reasoning effort.`);
  }
  const minutes = values.timeout === undefined ? 60 : Number(values.timeout);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
    throw new UsageError(`The timeout is in minutes, up to ${String(MAX_MINUTES)}.`);
  }
  return {
    kind: 'task',
    cwd,
    text,
    file,
    resume,
    model,
    effort,
    mode: values['read-only'] ? 'read-only' : 'auto',
    yes: values.yes ?? false,
    chatgptPlan: values['chatgpt-plan'] ?? false,
    timeoutMs: minutes * 60_000,
  };
}

const HEADINGS: Record<Delegation['outcome'], string> = {
  completed: 'Codex completed',
  failed: 'Codex failed',
  asked: 'Codex stopped to ask',
  stopped: 'Codex was stopped',
  'timed out': 'Codex ran out of time',
};

/** How the turn went, in Markdown: `changes` is what `git status --short` says of its folder. */
export function report(done: Delegation, changes: string): string {
  const lines = [`## ${HEADINGS[done.outcome]} in ${duration(done.seconds)}`, ''];
  if (done.asked !== undefined) lines.push(`**It asked:** ${done.asked}`, '');
  lines.push(`- Model: ${done.model}${done.effort === null ? '' : ` (${done.effort})`}`);
  if (done.thread !== null) {
    lines.push(`- Thread: \`${done.thread}\` (continue it with \`--resume ${done.thread}\`)`);
  }
  if (done.limits.length > 0) {
    const used = done.limits.map(
      (limit) => `${limit.name} ${String(Math.round(limit.usedPercent))}%`,
    );
    lines.push(`- Codex's usage: ${used.join(' · ')}`);
  }
  for (const notice of done.notices) lines.push(`- ${notice}`);
  lines.push('', '### What Codex said', '', done.reply === '' ? '(nothing)' : done.reply);
  lines.push('', '### Changes', '');
  lines.push(changes.trim() === '' ? 'No changes.' : ['```', changes.trimEnd(), '```'].join('\n'));
  return `${lines.join('\n')}\n`;
}

/** A length of time, as "2m 14s". */
function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** Codex's models, their efforts, and the user's own defaults, as --models lists them. */
function modelList({ models, defaults }: SettingsOptions): string {
  const lines = models.map((model) => {
    const efforts = (model.efforts ?? []).map((effort) =>
      effort.value === model.defaultEffort ? `${effort.value} (default)` : effort.value,
    );
    return `${model.value}: ${model.description ?? model.label}${
      efforts.length === 0 ? '' : `\n    efforts: ${efforts.join(', ')}`
    }`;
  });
  return `${lines.join('\n')}\n\nYour defaults: ${defaults.model ?? 'Codex’s'} model, ${
    defaults.effort ?? 'its default'
  } effort.\n`;
}

/** What changed in `cwd`, as git sees it: nothing where it is not a repository. */
async function changesIn(cwd: string, env: Readonly<Record<string, string>>): Promise<string> {
  const git = runGit(env);
  const status = await git(['status', '--short', '--untracked-files=all'], cwd).catch(() => null);
  if (status?.code !== 0) return '';
  const lines = await git(
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--shortstat', 'HEAD'],
    cwd,
  ).catch(() => null);
  return [status.stdout.trimEnd(), lines?.code === 0 ? lines.stdout.trim() : '']
    .filter((part) => part !== '')
    .join('\n');
}

const EXIT: Record<Delegation['outcome'], number> = {
  completed: 0,
  failed: 1,
  asked: 2,
  stopped: 3,
  'timed out': 3,
};

/** The user allowed the ChatGPT plan for this run (--chatgpt-plan). */
const PLAN_ALLOWED: PlanConsent = {
  given: () => Promise.resolve(true),
  give: () => Promise.resolve(),
};

/** Runs the command with `args`: resolves with the exit code. */
export async function main(args: readonly string[]): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 64;
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = path.resolve(command.cwd);
  if ((await stat(cwd).catch(() => undefined))?.isDirectory() !== true) {
    process.stderr.write(`There is no folder at ${cwd}.\n`);
    return 64;
  }
  const env = agentEnvironment(await loginShellEnvironment());
  const codex = await requireCodex(env);
  if (command.kind === 'models') {
    process.stdout.write(modelList(await codexOptions({ codex, cwd, env })));
    return 0;
  }
  const text =
    command.file === null
      ? command.text
      : (await readFile(path.resolve(command.file), 'utf8')).trim();
  if (text === '' || text.length > MAX_TASK) {
    process.stderr.write('The task file is empty, or too long.\n');
    return 64;
  }
  const connector = new AppServerConnector({
    clientApp: `corrallm-delegate/${process.env.npm_package_version ?? '0.0.0'}`,
    findCodex: () => Promise.resolve(codex),
    consent: command.chatgptPlan ? PLAN_ALLOWED : ASK_EACH_SESSION,
  });
  const stop = new AbortController();
  const abort = () => {
    stop.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const done = await delegate(
    connector,
    { ...command, cwd, env, text },
    (line) => {
      process.stderr.write(`${line}\n`);
    },
    stop.signal,
  );
  process.stdout.write(report(done, await changesIn(cwd, env)));
  return EXIT[done.outcome];
}
