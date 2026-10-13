import { MODEL_PATTERN } from '../../../../shared/session';
import type { CodexMode } from '../../../../shared/session';
import type { Launch, TerminalCli, TerminalSignal } from '../../terminal/cli';
import type { HookEvent, HookRegistration } from '../../terminal/hooks';
import type { Screen } from '../../terminal/screen';
import type { ProgramStatus } from '../../terminal/status';
import { composerDraft } from './composer';
import { hookOverrides, sessionHooks, toml, trustOverride } from './hooks';
import type { SessionHook } from './hooks';
import type { HookTrust } from './trust';

/*
 * Codex's interactive CLI (its TUI), as a Terminal session runs it (sessions/terminal/cli.ts),
 * read from Codex CLI 0.160.1 (recorded in fixtures/):
 *
 * - It starts as `codex --no-daemon -C <folder>` (`codex resume <id> …` to resume): its own agent,
 *   not the shared background server a desktop app may run, with overrides for this session only:
 *   the folder trusted (the user chose it in corrallm's folder dialog, which is the trust gate;
 *   otherwise Codex would ask, and write the answer to the user's config.toml), corrallm's hooks
 *   and their trust (hooks.ts, trust.ts), its window title set to say what it does, no update
 *   prompt and no automatic recaps (asked while its terminal is not focused, as most agents'
 *   are). Codex picks the session's id (a thread id), which its hooks tell.
 * - Its window title says what it does: "Ready" (idle), a spinner and "Working", "Thinking" or
 *   "Waiting", "Starting" (while its MCP servers start), "[ ! ] Action Required" (an approval, a
 *   question, a dialog that needs the user). Ready says a turn ended, and how: its Stop hook came
 *   (done), its Interrupt hook (interrupted), or neither after its UserPromptSubmit hook (it
 *   failed: Stop does not run for a turn that errs, as at a usage limit).
 * - A message is pasted in (bracketed paste: its line breaks stay, nothing in it is taken as a
 *   key), then sent with Enter. It is typed only into its composer, as drawn (composer.ts): the
 *   title says nothing of its pickers and startup screens.
 */

/** Bracketed paste: what a terminal sends around pasted text. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Its title, as corrallm asks it to be: what it is doing, and its state. */
const TITLE = '["activity","run-state"]';
/** The states its title says (the last word), and what they mean to corrallm. */
const WORKING = new Set(['Working', 'Thinking', 'Waiting']);

/** The flags of each mode. Default ('auto') and Plan leave the user's own defaults be. */
const MODE_FLAGS: Record<CodexMode, readonly string[]> = {
  'read-only': ['-s', 'read-only', '-a', 'on-request'],
  auto: [],
  'full-access': ['-s', 'danger-full-access', '-a', 'never'],
  plan: [],
};

export interface CodexTuiOptions {
  /** The trust its hooks need: their keys and hashes (trust.ts). */
  trust: (hooks: readonly SessionHook[]) => Promise<HookTrust>;
  /**
   * The reasoning effort corrallm chose (on the agent's App Server connection: its terminal has no
   * picker of corrallm's), or null for the user's own.
   */
  effort?: string | null;
  platform?: NodeJS.Platform;
}

export class CodexTui implements TerminalCli<CodexMode> {
  readonly name = 'Codex';
  readonly words = {
    answer: 'Answer Codex in its terminal.',
    mode: 'Switch modes in Codex’s terminal (/permissions, or Shift+Tab for Plan).',
    model: 'Switch models in Codex’s terminal (/model).',
    login: 'Codex needs you to log in: sign in in its terminal.',
    waiting: {
      permission: 'Codex asks for your approval.',
      question: 'Codex asks you something.',
      auth: 'Codex needs you to log in: sign in in its terminal.',
      none: 'Codex needs you: see its terminal.',
    },
  };
  /** Codex's Default, which leaves the user's own approval and sandbox settings be. */
  readonly defaultMode = 'auto';
  readonly waitsForPrompt = true;
  readonly #trust: (hooks: readonly SessionHook[]) => Promise<HookTrust>;
  readonly #effort: string | null;
  readonly #platform: NodeJS.Platform;
  /** The overrides that add its hooks and trust them, once prepared. */
  #hooks: string[] = [];

  /** Whether its title has said anything yet: it says nothing while a startup screen is up. */
  #titled = false;
  /** Its title says its MCP servers are starting (a message sent meanwhile waits for them). */
  #starting = false;
  /** Since its title last said Ready: it worked, took a prompt, stopped, was interrupted. */
  #ran = false;
  #prompted = false;
  #stopped = false;
  #interrupted = false;
  /** The model its hooks last said. */
  #model: string | undefined;

  constructor({ trust, effort = null, platform = process.platform }: CodexTuiOptions) {
    this.#trust = trust;
    this.#effort = effort;
    this.#platform = platform;
  }

  newId(): null {
    return null;
  }

  async prepare(_dir: string, hooks: HookRegistration): Promise<void> {
    const session = sessionHooks(hooks.url, this.#platform);
    const trust = await this.#trust(session);
    this.#hooks = [...hookOverrides(session), trustOverride(trust)];
  }

  args({ id, resume, model, mode, cwd }: Launch<CodexMode>): string[] {
    const overrides = [
      `projects={${toml(cwd)}={trust_level="trusted"}}`,
      ...this.#hooks,
      `tui.terminal_title=${TITLE}`,
      'check_for_update_on_startup=false',
      'tui.auto_recap=false',
      ...(this.#effort === null ? [] : [`model_reasoning_effort=${toml(this.#effort)}`]),
    ];
    return [
      ...(resume && id !== null ? ['resume', id] : []),
      '--no-daemon',
      '-C',
      cwd,
      ...overrides.flatMap((override) => ['-c', override]),
      ...(model === null ? [] : ['-m', model]),
      ...(mode === null ? [] : MODE_FLAGS[mode]),
    ];
  }

  resumeFailed(screen: string): boolean {
    return /No saved session found/i.test(screen);
  }

  holds(): boolean {
    return this.#starting;
  }

  title(title: string): ProgramStatus | undefined {
    this.#titled = true;
    if (title.includes('Action Required')) {
      this.#ran = true;
      return { state: 'blocked' };
    }
    const state = /(\w+)\s*$/.exec(title)?.[1];
    if (state === 'Starting') {
      this.#starting = true;
      return undefined;
    }
    if (state === undefined || (state !== 'Ready' && !WORKING.has(state))) return undefined;
    this.#starting = false;
    if (state !== 'Ready') {
      this.#ran = true;
      return { state: 'working' };
    }
    const report = this.#ended();
    this.#ran = this.#prompted = this.#stopped = this.#interrupted = false;
    return report;
  }

  /** How the turn that went on ended, now that its title says Ready. */
  #ended(): ProgramStatus {
    if (this.#stopped) return { state: 'done' };
    if (this.#interrupted || !this.#ran) return { state: 'idle' };
    // It took a prompt (its hooks run), worked, and stopped without its Stop hook: it failed.
    if (this.#prompted) {
      return { state: 'error', msg: 'Codex stopped before it finished: its terminal says why.' };
    }
    // A turn without hooks (a slash command's, or hooks turned off): done, as far as corrallm knows.
    return { state: 'done' };
  }

  hook(event: HookEvent): TerminalSignal<CodexMode>[] {
    const text = (key: string) => {
      const value = event[key];
      return typeof value === 'string' ? value : undefined;
    };
    // A subagent's thread (it has its own id): its prompts and turns are not the session's.
    if (event.agent_id !== undefined && event.agent_id !== null) return [];
    const signals: TerminalSignal<CodexMode>[] = [];
    const id = text('session_id');
    if (id !== undefined) signals.push({ kind: 'session', id });
    const model = text('model');
    if (model !== undefined && model !== this.#model && MODEL_PATTERN.test(model)) {
      this.#model = model;
      signals.push({ kind: 'model', model });
    }
    switch (text('hook_event_name')) {
      case 'UserPromptSubmit':
        this.#prompted = true;
        signals.push({ kind: 'prompt', text: text('prompt') ?? '' });
        break;
      case 'Stop': {
        this.#stopped = true;
        const reply = text('last_assistant_message');
        if (reply !== undefined) signals.push({ kind: 'reply', text: reply });
        break;
      }
      case 'Interrupt':
        this.#interrupted = true;
        break;
    }
    return signals;
  }

  draft(screen: Screen): string | undefined {
    // Until its title first says something, a startup screen is up (or it is still loading).
    return this.#titled ? composerDraft(screen) : undefined;
  }

  keystrokes(text: string): string[] {
    const paste = pasteable(text);
    return paste.trim() === '' ? [] : [`${PASTE_START}${paste}${PASTE_END}`];
  }

  submitted(text: string): string {
    return pasteable(text).trim();
  }
}

/**
 * `text` as it can be pasted: line breaks as newlines, without control characters (an escape
 * would end the paste early, and what follows would be taken as keys).
 */
export function pasteable(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
