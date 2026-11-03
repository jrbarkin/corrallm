#!/usr/bin/env node
// A fake `claude` for the e2e tests (CORRALLM_AGENT_PATHS points at it): Claude Code's interactive
// CLI as corrallm's terminal sees it, printing what the real one does (recorded from 2.1.296):
// its terminal probes, Program Status reports (OSC 7501), a prompt box with a dim placeholder,
// the folder trust dialog, and the hooks it was given in --settings, posted to their server.
//
// It keeps its state in the folder it runs in, under .fake-claude/: log.jsonl (how it was
// started, each prompt it got, each signal) for the tests to read, and one file per session
// (its "transcript", which --resume needs). A file .fake-claude-untrusted in the folder makes it
// ask whether to trust the folder first.
//
// Prompts: "ask …" asks for permission first (its permission hook, then its report; 1 or Enter:
// yes), "question …" asks a question (AskUserQuestion: its tool's hook, then the permission
// hook; 1 or Enter answers), "slow …" works until Escape, "link …" is answered with a link,
// "files …" with links (OSC 8) to notes.txt in its folder and outside.txt beside it, anything
// else is answered at once. A paste (bracketed, as it asks for) goes into the prompt,
// and is logged. Its terminal's size is logged as it changes, so a test can tell where a cell is
// drawn.
//
// `claude auth status --json` reports a Claude subscription login (claude.ai), unless the
// environment has an API key, as the real one does; `claude --help` lists some of the real one's
// options (--effort among them). Neither logs anything.
//
// With a file .fake-claude-usage.json in the folder (its usage limits, as Claude Code's status line
// input has them: { "five_hour": { "used_percentage", "resets_at" }, ... }), it runs the status
// line its --settings give once it is ready and after each reply, as Claude Code does (`/bin/sh -c`,
// its input on stdin), and shows and logs what that printed.
import { fallbackTurn } from './fallback.mjs';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (flag) => {
  const assigned = args.find((arg) => arg.startsWith(`${flag}=`));
  if (assigned !== undefined) return assigned.slice(flag.length + 1);
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
if (args[0] === '--help') {
  process.stdout.write(
    [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Options:',
      '  --effort <level>                      Effort level for the current session',
      '                                        (low, medium, high, xhigh, max)',
      '  --model <model>                       Model for the current session. Provide',
      '                                        an alias for the latest model (e.g.',
      "                                        'fable', 'opus', or 'sonnet')",
      '  --permission-mode <mode>              Permission mode to use for the session',
      '  -r, --resume [value]                  Resume a conversation by session ID',
      '  --session-id <uuid>                   Use a specific session ID',
      '  --settings <file-or-json>             Path to a settings JSON file',
      '  --append-system-prompt <prompt>       Append to the default system prompt',
      '  --system-prompt-snapshot <on|off>     Record and reuse the system prompt',
      '',
    ].join('\n'),
  );
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const status = process.env.ANTHROPIC_API_KEY
    ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
    : {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
      };
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(0);
}
// Its session's own corrallm entry (--mcp-config), connected and listed as it starts, as the real
// one does; a turn's scripted calls (FAKE_MCP_SCRIPT) go through it. A route that fails to connect
// is logged (FAKE_MCP_LOG) and the CLI starts without it, as Claude Code does.
const mcp = await import('../../fake-mcp-client.mjs');
let api;
const mcpFile = arg('--mcp-config');
if (mcpFile !== undefined) {
  const entry = JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers.corrallm;
  const token = entry.headers.Authorization.slice('Bearer '.length);
  try {
    api = await mcp.connectHttp({ url: entry.url, token });
    mcp.logConnected(token);
    await api.list();
    if (process.env.FAKE_MCP_TOOL) await api.call(process.env.FAKE_MCP_TOOL, {});
  } catch (error) {
    mcp.logScripted({ event: 'connect-failed', error: String(error?.message ?? error) });
    api = undefined;
  }
  process.once('exit', () => {
    void api?.close();
  });
}
// Outside registrations, as Claude Code treats them (recorded, fixtures/mcp-entry.json's
// switchedOff), for a test that logs its calls: each user-scope MCP server in CLAUDE_CONFIG_DIR's
// .claude.json that the session's --settings don't deny has its headersHelper run in a shell, in
// this process's environment, as it connects; a denied one never connects, and its helper never
// runs. Logged: what of an outside registration's environment reached it, and per server whether
// it was denied, its helper's exit status and whether it printed anything (never what).
if (process.env.FAKE_MCP_LOG && process.env.CLAUDE_CONFIG_DIR) {
  const settings = arg('--settings');
  const denied = new Set(
    (settings === undefined
      ? []
      : (JSON.parse(readFileSync(settings, 'utf8')).deniedMcpServers ?? [])
    ).map((one) => one.serverName),
  );
  let servers;
  try {
    servers =
      JSON.parse(readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'))
        .mcpServers ?? {};
  } catch {
    servers = {};
  }
  mcp.logScripted({
    event: 'environment',
    outsideToken: process.env.CORRALLM_OUTSIDE_TOKEN !== undefined,
    agentSession: process.env.CORRALLM_AGENT_SESSION ?? null,
  });
  for (const [name, server] of Object.entries(servers)) {
    if (denied.has(name)) {
      mcp.logScripted({ event: 'outside-server', name, denied: true });
      continue;
    }
    if (typeof server.headersHelper !== 'string') continue;
    const ran = spawnSync('/bin/sh', ['-c', server.headersHelper], {
      env: process.env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    mcp.logScripted({
      event: 'outside-server',
      name,
      denied: false,
      helperExit: ran.status,
      printed: (ran.stdout ?? '').trim() !== '',
    });
  }
}
const home = path.join(process.cwd(), '.fake-claude');
mkdirSync(home, { recursive: true });
const log = (entry) => appendFileSync(path.join(home, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
const out = (data) => process.stdout.write(data);
const report = (fields) => {
  if (reporting) out(`\x1b]7501;${fields}:app=claude-code\x07`);
};

const resume = arg('--resume');
const sessionId = resume ?? arg('--session-id') ?? 'none';
let reporting = false;
let trusting = existsSync(path.join(process.cwd(), '.fake-claude-untrusted'));
let trustChoice = 0;
let state = 'starting';
let draft = '';
let lines = [];

log({ event: 'start', args, cwd: process.cwd(), term: process.env.TERM });

function quit(code) {
  out('\x1b]7501;state=clear\x07');
  log({ event: 'exit', code });
  process.exit(code);
}
for (const signal of ['SIGHUP', 'SIGTERM']) {
  process.on(signal, () => {
    log({ event: 'signal', signal });
    // A test that logs its calls also learns whether this session's credential still works as it
    // closes (its close revoked it first).
    if (process.env.FAKE_MCP_LOG && api !== undefined) {
      void mcp.closingCall(api).finally(() => {
        quit(0);
      });
    } else quit(0);
  });
}

async function hook(name, fields = {}) {
  const settings = arg('--settings');
  if (!settings) return;
  const group = JSON.parse(readFileSync(settings, 'utf8')).hooks[name]?.[0];
  const url = group?.hooks[0]?.url;
  if (!url) return;
  // Only for the tools its matcher names, if it names any.
  if (group.matcher && !group.matcher.split('|').includes(fields.tool_name)) return;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: group.hooks[0].headers.Authorization,
    },
    body: JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      permission_mode: 'default',
      hook_event_name: name,
      ...fields,
    }),
  }).catch(() => undefined);
}

let statusText = '';
let scriptedStatus = Promise.resolve();

/** Runs the status line from --settings, as Claude Code does, if usage limits are given. */
function statusLine(reading) {
  const usage = path.join(process.cwd(), '.fake-claude-usage.json');
  const settings = arg('--settings');
  if (!settings || (!reading && !existsSync(usage))) return Promise.resolve();
  const given = JSON.parse(readFileSync(settings, 'utf8'));
  const command = given.statusLine?.command;
  if (typeof command !== 'string') return Promise.resolve();
  const input = {
    session_id: sessionId,
    cwd: process.cwd(),
    model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
    ...(existsSync(usage) ? { rate_limits: JSON.parse(readFileSync(usage, 'utf8')) } : {}),
    ...reading,
  };
  if (process.env.FAKE_CLAUDE_FALLBACK) {
    // Scripted journeys need the recorded reading-before-Stop order. The real wrapper's
    // background curl can finish after its shell exits: acknowledge the same native /status
    // channel here, serially, including the initial reading. Ordinary turns still run the shell.
    const registration = given.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    if (registration?.type !== 'http')
      throw new Error('The scripted fake needs its native HTTP hook.');
    const url = new URL(registration.url);
    if (url.pathname !== '/hook') throw new Error('The scripted fake needs its native hook route.');
    url.pathname = '/status';
    scriptedStatus = scriptedStatus.then(async () => {
      log({ event: 'statusline-reading', input });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: registration.headers.Authorization,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok)
        throw new Error(`The native status reading was refused (${response.status}).`);
      log({ event: 'statusline', code: response.status });
    });
    return scriptedStatus;
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: process.cwd(), env: process.env });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      statusText = output.trim();
      log({ event: 'statusline', output, code });
      draw();
      resolve();
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function draw() {
  if (trusting) {
    out(
      '\x1b[H\x1b[2J Accessing workspace:\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n' +
        `${trustChoice === 0 ? ' ❯' : '  '} No, exit\r\n${trustChoice === 1 ? ' ❯' : '  '} Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel`,
    );
    return;
  }
  const box = draft === '' ? ['\x1b[2mTry "fix lint errors"\x1b[22m'] : draft.split('\n');
  out(
    `\x1b[H\x1b[2J ✻ Claude Code (fake)  ${sessionId}\r\n\r\n` +
      lines.map((line) => `${line}\r\n`).join('') +
      `${'─'.repeat(60)}\r\n` +
      box.map((line, i) => `${i === 0 ? '❯ ' : '  '}${line}`).join('\r\n') +
      `\r\n${'─'.repeat(60)}\r\n  ${state === 'working' ? '✻ Working… (esc to interrupt)' : '? for shortcuts'}` +
      (statusText === '' ? '' : `\r\n  ${statusText}`),
  );
}

function become(next, extra = '') {
  state = next;
  report(`state=${next}${extra}`);
}

async function submit() {
  const prompt = draft;
  if (prompt === '' || state === 'working' || state === 'blocked') return;
  draft = '';
  log({ event: 'prompt', text: prompt });
  writeFileSync(path.join(home, sessionId), 'transcript\n');
  if (prompt === '/exit') quit(0);
  become('working');
  lines.push(`> ${prompt.split('\n').join(' ⏎ ')}`);
  draw();
  await hook('UserPromptSubmit', { prompt });
  // Its scripted calls to corrallm's tools, made in this turn; their rule's reply ends it.
  const scripted = await mcp.scriptedTurn(api, prompt);
  if (scripted !== undefined) {
    setTimeout(() => void finish({ reply: scripted }), 100);
    return;
  }
  const script = process.env.FAKE_CLAUDE_FALLBACK;
  const planned = fallbackTurn(
    script ? JSON.parse(readFileSync(script, 'utf8')) : undefined,
    prompt,
    Date.now(),
  );
  if (planned && !planned.ask) {
    if (planned.gate) {
      writeFileSync(`${planned.gate}.waiting`, 'waiting');
      while (state === 'working' && !existsSync(planned.gate))
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (state !== 'working') return;
    if (planned.reading) await statusLine(planned.reading);
    if (planned.fail) {
      await hook('StopFailure', {
        error: 'rate_limit',
        error_details: 'The native test account reached its limit.',
      });
      become('error', `:msg=${Buffer.from('You’ve hit your limit').toString('base64')}`);
      log({ event: 'failed', text: prompt });
      draw();
    } else await finish(planned);
    return;
  }
  if (planned?.ask || prompt.startsWith('ask')) {
    await hook('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello', description: 'Say hello' },
    });
    become(
      'blocked',
      `:kind=permission:msg=${Buffer.from('approve Bash: echo hello').toString('base64')}`,
    );
    lines.push('Bash(echo hello) · Do you want to proceed? 1. Yes  2. No');
    draw();
    return;
  }
  if (prompt.startsWith('question')) {
    const input = {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'What the app uses today' },
            { label: 'SQLite', description: 'One file, for tests' },
          ],
          multiSelect: false,
        },
      ],
    };
    await hook('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: input,
      tool_use_id: 'toolu_question',
    });
    await hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: input });
    become(
      'blocked',
      `:kind=question:msg=${Buffer.from('answer: Which database? (Postgres · SQLite)').toString('base64')}`,
    );
    lines.push('Which database? 1. Postgres  2. SQLite');
    draw();
    return;
  }
  if (prompt.startsWith('slow')) return;
  // The continuity specs release a native turn only after observing a lost/replaced view.
  const gate = JSON.parse(process.env.FAKE_CLAUDE_TURN_GATES ?? '{}')[prompt];
  if (typeof gate === 'string') {
    writeFileSync(`${gate}.waiting`, 'waiting');
    while (state === 'working' && !existsSync(gate)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (state !== 'working') return;
  }
  setTimeout(() => void finish(), 300);
}

/** `text`, as an OSC 8 link to `file` (as Claude Code prints the files it names). */
const fileLink = (file, text) => `\x1b]8;;${pathToFileURL(file).href}\x07${text}\x1b]8;;\x07`;

async function finish(planned) {
  if (state !== 'working') return;
  const said = lines.at(-1)?.slice(2) ?? '';
  const reply =
    planned?.reply ??
    (said.startsWith('corrallm asks: is this true now?')
      ? 'No.'
      : said.startsWith('link')
        ? 'See https://docs.example.com/hooks for more'
        : said.startsWith('files')
          ? 'Wrote notes.txt and read outside.txt'
          : `You said: ${said}${/SUCCEEDED or FAILED on a line of its own/.test(said) ? '\nSUCCEEDED' : ''}`);
  lines.push(
    said.startsWith('files')
      ? `⏺ Wrote ${fileLink(path.resolve('notes.txt'), 'notes.txt')} and read ${fileLink(path.resolve('..', 'outside.txt'), 'outside.txt')}`
      : `⏺ ${reply}`,
  );
  await hook('Stop', { last_assistant_message: reply });
  if (state !== 'working') return;
  become('done');
  draw();
  log({ event: 'replied', text: reply });
  if (!planned) await statusLine();
}

// What a terminal answers to the probes above (OSC replies, CSI replies led by ? or >) and its
// focus reports. A pty read can join these with keys typed right after them, so they are taken
// out wherever they sit, not only when they lead the chunk (that dropped the typed keys with them).
const TERMINAL_REPLIES =
  // eslint-disable-next-line no-control-regex
  /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\|$)|\x1b\[[?>][0-9;:]*[A-Za-z]|\x1b\[[IO]/g;

function key(received) {
  let data = received;
  if (!data.startsWith('\x1b[200~')) {
    data = data.replace(TERMINAL_REPLIES, (reply) => {
      // The Program Status probe's answer says the terminal supports it.
      if (reply.startsWith('\x1b]7501;?')) {
        reporting = true;
        if (state === 'starting' && !trusting) {
          become('idle');
          draw();
          void statusLine();
        }
      }
      return '';
    });
    if (data === '') return;
  }
  if (data.startsWith('\x1b[200~')) {
    const end = data.indexOf('\x1b[201~');
    const text = data.slice(6, end === -1 ? undefined : end);
    log({ event: 'paste', text });
    draft += text;
    draw();
    return;
  }
  if (data.startsWith('\x1b[?') || data.startsWith('\x1b]')) return;
  if (trusting) {
    if (data === '\x1b[B' || data === '\x1b[A') trustChoice = 1 - trustChoice;
    else if (data === '\r') {
      if (trustChoice === 0) quit(1);
      trusting = false;
      rmSync(path.join(process.cwd(), '.fake-claude-untrusted'), { force: true });
      log({ event: 'trusted' });
      become('idle');
    } else if (data === '\x1b') quit(0);
    draw();
    return;
  }
  if (state === 'blocked') {
    if (data === '1' || data === '\r') {
      lines.push('⏺ Bash(echo hello) ⎿ hello');
      become('working');
      setTimeout(() => void finish(), 200);
    } else if (data === '\x1b' || data === '2') become('idle');
    draw();
    return;
  }
  if (data === '\x1b') {
    if (state === 'working') {
      lines.push('⎿ Interrupted · What should Claude do instead?');
      become('idle');
    }
    draw();
    return;
  }
  if (data.startsWith('\x1b')) {
    // Shift+Enter (ESC CR): a new line in the prompt; other keys are not handled.
    if (data === '\x1b\r') draft += '\n';
    draw();
    return;
  }
  for (const character of data) {
    if (character === '\r') void submit();
    else if (character === '\x03') draft = '';
    else if (character === '\x7f') draft = draft.slice(0, -1);
    else if (character === '\n' || character >= ' ') draft += character;
  }
  draw();
}

if (resume !== undefined && !existsSync(path.join(home, resume))) {
  out(`No conversation found with session ID: ${resume}\r\n`);
  log({ event: 'exit', code: 1 });
  process.exit(1);
}
const size = () => log({ event: 'size', cols: process.stdout.columns, rows: process.stdout.rows });
size();
process.stdout.on('resize', size);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', key);
// Keys typed before this were the terminal driver's to buffer (as a line), as in any terminal.
log({ event: 'ready' });
out('\x1b[?2004h\x1b[?2031h\x1b[?1004h');
out('\x1b]11;?\x07\x1b[c\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c');
out('\x1b]0;Claude Code\x07');
if (trusting) draw();
