#!/usr/bin/env node
// A fake `codex` for the e2e tests (CORRALLM_CODEX_PATH points at it): Codex's interactive CLI as
// corrallm's terminal sees it, printing what the real one does (recorded from 0.160.1, see
// src/main/sessions/codex/terminal/fixtures/): its terminal probes, its window titles (Ready, a
// spinner and Working or Starting, "[ ! ] Action Required"), a shaded composer with a dim
// placeholder and the cursor in it, and the hooks it was given with -c, run as Codex runs them
// (the user's shell, the event on stdin), but only if trusted as Codex trusts them (hooks.state;
// else it stops at "Hooks need review"). It asks to trust the folder unless told it is trusted.
// `codex --version` says 0.160.1, and `codex app-server` lists its hooks (hooks/list), says
// its usage limits (account/rateLimits/read: the RateLimitSnapshot in .fake-codex-usage.json in
// the folder it runs in, or, without one, that it has none), lists two models (model/list) and
// says the user's config (config/read: GPT-6.1-Sol at max effort, no sandbox or approvals set),
// logging each request it gets in .fake-codex/app-server.jsonl.
//
// It keeps its state in the folder it runs in, under .fake-codex/: log.jsonl (how it was
// started, each prompt it got, how it ended) for the tests to read, and one file per session
// (Codex keeps a session once it has had a prompt), which `resume <id>` needs.
//
// Prompts: "ask …" asks to approve a command first (y: yes, Esc: no), "slow …" works until
// Escape, "fail …" stops without finishing (as at a usage limit), anything else is answered.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.160.1';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}

const LABELS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

/** Its -c overrides, by key. */
const overrides = new Map();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '-c') continue;
  const value = argv[i + 1] ?? '';
  const at = value.indexOf('=');
  overrides.set(value.slice(0, at), value.slice(at + 1));
}
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** Its hooks, from -c hooks.<Event>=[{hooks=[{type="command",command="…",timeout=N}]}]. */
const hooks = Object.keys(LABELS).flatMap((event) => {
  const value = overrides.get(`hooks.${event}`);
  if (value === undefined) return [];
  const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(value)?.[1] ?? '""');
  const timeout = Number(/timeout=(\d+)/.exec(value)?.[1] ?? (event === 'Interrupt' ? 1 : 600));
  const key = `/<session-flags>/config.toml:${LABELS[event]}:0:0`;
  return [{ event, command, timeout, key, hash: hookHash(event, command, timeout) }];
});

/** Codex's hook hash: SHA-256 of the hook's identity, as JSON with sorted keys. */
function hookHash(event, command, timeout) {
  const identity = {
    event_name: LABELS[event],
    hooks: [{ async: false, command, timeout, type: 'command' }],
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

if (argv[0] === 'app-server') {
  // Just enough of its app server: hello, then hooks/list and account/rateLimits/read; it ends
  // with its input.
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const home = path.join(process.cwd(), '.fake-codex');
  const usage = path.join(process.cwd(), '.fake-codex-usage.json');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method } = JSON.parse(line);
    if (id === undefined) return;
    mkdirSync(home, { recursive: true });
    appendFileSync(path.join(home, 'app-server.jsonl'), `${JSON.stringify({ method })}\n`);
    if (method === 'account/rateLimits/read') {
      if (!existsSync(usage)) send({ id, error: { code: -32600, message: 'no plan limits' } });
      else send({ id, result: { rateLimits: JSON.parse(readFileSync(usage, 'utf8')) } });
    } else if (method === 'initialize') {
      send({ id, result: { userAgent: `corrallm/${VERSION}`, codexHome: '/nowhere' } });
    } else if (method === 'model/list') {
      const model = (name, displayName, efforts, isDefault) => ({
        id: name,
        model: name,
        displayName,
        description: `${displayName}, for tests`,
        hidden: false,
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
          reasoningEffort,
          description: `${reasoningEffort} effort`,
        })),
        defaultReasoningEffort: efforts[0],
        inputModalities: ['text', 'image'],
        isDefault,
      });
      send({
        id,
        result: {
          data: [
            model('gpt-6.1-sol', 'GPT-6.1-Sol', ['low', 'medium', 'high', 'xhigh', 'max'], true),
            model('gpt-6-luna', 'GPT-6-Luna', ['low', 'medium', 'high'], false),
          ],
          nextCursor: null,
        },
      });
    } else if (method === 'config/read') {
      const config = {
        model: 'gpt-6.1-sol',
        model_reasoning_effort: 'max',
        approval_policy: null,
        sandbox_mode: null,
      };
      send({ id, result: { config, origins: {}, layers: null } });
    } else if (method === 'hooks/list') {
      const listed = hooks.map(({ key, command, hash }) => ({
        key,
        command,
        source: 'sessionFlags',
        currentHash: hash,
        trustStatus: 'untrusted',
      }));
      send({ id, result: { data: [{ cwd: process.cwd(), hooks: listed }] } });
    } else send({ id, error: { code: -32601, message: `no ${method}` } });
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  runTui();
}

function runTui() {
  const cwd = flag('-C') ?? process.cwd();
  const home = path.join(cwd, '.fake-codex');
  mkdirSync(home, { recursive: true });
  const log = (entry) => appendFileSync(path.join(home, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
  const out = (data) => process.stdout.write(data);
  const title = (text) => out(`\x1b]0;${text}\x07`);

  const resume = argv[0] === 'resume' ? argv[1] : undefined;
  const sessionId = resume ?? randomUUID();
  const trusted = (overrides.get('projects') ?? '').includes(JSON.stringify(cwd));
  const states = overrides.get('hooks.state') ?? '';
  const untrusted = hooks.filter(
    ({ key, hash }) => !states.includes(`${JSON.stringify(key)}={trusted_hash="${hash}"}`),
  );
  let screen = trusted ? (untrusted.length > 0 ? 'hooks' : 'chat') : 'trust';
  let state = 'ready';
  let draft = '';
  const lines = [];
  let spinner = 0;
  let spinning;
  let turnId;
  /** A message submitted while its MCP servers started. */
  let held;

  log({ event: 'start', args: argv, cwd: process.cwd(), term: process.env.TERM });

  function quit(code) {
    log({ event: 'exit', code });
    out('\x1b[?1049l\x1b[?2004l');
    process.exit(code);
  }
  for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => quit(0));

  /** Runs a hook as Codex does: the user's shell, the event on stdin; waits for it. */
  function hook(event, fields = {}) {
    const found = hooks.find((one) => one.event === event);
    if (!found || untrusted.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', found.command], {
        cwd,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('close', resolve);
      child.on('error', resolve);
      child.stdin.end(
        JSON.stringify({
          session_id: sessionId,
          transcript_path: null,
          cwd,
          hook_event_name: event,
          model: flag('-m') ?? 'gpt-fake',
          permission_mode: flag('-a') === 'never' ? 'bypassPermissions' : 'default',
          ...fields,
        }),
      );
    });
  }

  const SHADE = '\x1b[48;2;55;55;57m';
  function draw() {
    out('\x1b[?2026h\x1b[H\x1b[2J');
    if (screen === 'trust') {
      out(
        `\r\n  Folder access\r\n\r\n  ${cwd}\r\n\r\n  Trust this folder?\r\n\r\n` +
          '\x1b[1m› 1. Trust and continue\x1b[22m\r\n  2. Quit\r\n\r\n  enter continue · esc quit\x1b[?2026l',
      );
      return;
    }
    if (screen === 'hooks') {
      out(
        `\r\n  Hooks need review\r\n\r\n  ${String(untrusted.length)} hook is new or changed.\r\n\r\n` +
          '\x1b[1m› 1. Review hooks\x1b[22m\r\n  2. Trust all and continue\r\n  3. Continue without trusting\x1b[?2026l',
      );
      return;
    }
    out(`\r\n  \x1b[1m>_ OpenAI Codex (fake)\x1b[22m (v${VERSION})\r\n  ${sessionId}\r\n\r\n`);
    for (const line of lines) out(`${line}\r\n`);
    if (state === 'asking') {
      out(
        '\r\n  Would you like to run the following command?\r\n\r\n  $ echo hello\r\n\r\n' +
          '\x1b[1m› 1. Yes, proceed (y)\x1b[22m\r\n  2. No, and tell Codex what to do differently (esc)\r\n' +
          '\r\n  Press enter to confirm or esc to cancel\x1b[?25l\x1b[?2026l',
      );
      return;
    }
    // The composer: shaded, its placeholder dim, the cursor in it.
    const row = 26;
    const text =
      draft === '' ? '\x1b[2mAsk Codex to do anything\x1b[22m' : draft.replace(/\n/g, ' ');
    out(
      `\x1b[${String(row - 1)};1H${SHADE}\x1b[K \x1b[0m` +
        `\x1b[${String(row)};1H${SHADE}\x1b[K\x1b[1m›\x1b[22m ${text}\x1b[0m` +
        `\x1b[${String(row + 1)};1H${SHADE}\x1b[K \x1b[0m` +
        `\x1b[${String(row + 3)};3H${state === 'working' ? 'esc to interrupt' : '? for shortcuts'}` +
        `\x1b[${String(row)};${String(3 + draft.length)}H\x1b[?25h\x1b[?2026l`,
    );
  }

  function become(next) {
    state = next;
    clearInterval(spinning);
    spinning = undefined;
    if (next === 'working') {
      const frame = () => title(`${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[spinner++ % 10]} Working`);
      frame();
      spinning = setInterval(frame, 100);
    } else if (next === 'asking') title('[ ! ] Action Required');
    else title('Ready');
  }

  async function submit(prompt = draft) {
    if (prompt.trim() === '' || (state !== 'ready' && state !== 'starting')) return;
    draft = '';
    // While its MCP servers start, a message submitted waits for them (out of the composer).
    if (state === 'starting') {
      held = prompt;
      draw();
      return;
    }
    if (prompt === '/quit') quit(0);
    log({ event: 'prompt', text: prompt, session: sessionId });
    turnId = randomUUID();
    lines.push(`› ${prompt.split('\n').join(' ⏎ ')}`);
    become('working');
    draw();
    writeFileSync(path.join(home, sessionId), 'thread\n');
    await hook('UserPromptSubmit', { turn_id: turnId, prompt });
    if (prompt.startsWith('ask')) {
      await hook('PermissionRequest', { turn_id: turnId, tool_name: 'Bash' });
      become('asking');
      draw();
      return;
    }
    if (prompt.startsWith('slow')) return;
    setTimeout(() => void finish(prompt), 300);
  }

  async function finish(prompt) {
    if (state !== 'working') return;
    if (prompt.startsWith('fail')) {
      lines.push('■ You’ve hit your usage limit.');
    } else {
      const reply = `You said: ${prompt}`;
      lines.push(`• ${reply}`);
      await hook('Stop', {
        turn_id: turnId,
        stop_hook_active: false,
        last_assistant_message: reply,
      });
    }
    if (state !== 'working') return;
    become('ready');
    draw();
  }

  async function interrupt() {
    await hook('Interrupt', { turn_id: turnId });
    lines.push('■ Conversation interrupted');
    become('ready');
    draw();
  }

  function key(data) {
    // Answers to its probes, and focus reports.
    // eslint-disable-next-line no-control-regex -- they are escape sequences
    if (/^\x1b(\[\?|\]|\[I|\[O|\[\d+;\d+R)/.test(data)) return;
    if (screen === 'trust' || screen === 'hooks') {
      if (data === '\r' && screen === 'trust') {
        screen = untrusted.length > 0 ? 'hooks' : 'chat';
        log({ event: 'trusted' });
        if (screen === 'chat') ready();
        else draw();
      } else if (data === '\x1b') quit(1);
      return;
    }
    if (state === 'asking') {
      if (data === 'y') {
        lines.push('• Ran echo hello');
        become('working');
        draw();
        setTimeout(() => void finish('ask'), 200);
      } else if (data === '\x1b') void interrupt();
      return;
    }
    if (data === '\x1b') {
      if (state === 'working') void interrupt();
      return;
    }
    if (data.startsWith('\x1b[200~')) {
      draft += data.slice(6, data.endsWith('\x1b[201~') ? -6 : undefined);
      draw();
      return;
    }
    if (data.startsWith('\x1b')) return;
    for (const character of data) {
      if (character === '\r') void submit();
      else if (character === '\x03') draft = '';
      else if (character === '\x7f') draft = draft.slice(0, -1);
      else if (character === '\n' || character >= ' ') draft += character;
    }
    draw();
  }

  function ready() {
    draw();
    title('Ready');
    log({ event: 'ready' });
    // Its MCP servers start: a message sent meanwhile waits for them.
    state = 'starting';
    let frames = 0;
    const starting = setInterval(() => {
      title(`${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[frames % 10]} Starting`);
      frames += 1;
      if (frames < 4) return;
      clearInterval(starting);
      state = 'ready';
      if (held !== undefined) {
        const prompt = held;
        held = undefined;
        void submit(prompt);
      } else title('Ready');
    }, 100);
  }

  if (resume !== undefined && !existsSync(path.join(home, resume))) {
    out('\x1b[?2004h\x1b[?1049h');
    out('\x1b[?1049l');
    out(
      `ERROR: No saved session found with ID ${resume}. Run \`codex resume\` without an ID to choose from existing sessions.\r\n`,
    );
    log({ event: 'exit', code: 1 });
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key);
  // Its probes, then its screen, as the real one starts.
  out('\x1b[?2004h\x1b[>4;0m\x1b[?1004h\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c');
  out('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  if (screen === 'chat') setTimeout(ready, 150);
  else draw();
}
