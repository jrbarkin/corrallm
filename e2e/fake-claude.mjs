#!/usr/bin/env node
// A fake `claude` for the e2e tests (CORRALLM_CLAUDE_PATH points at it): Claude Code's interactive
// CLI as corrallm's terminal sees it, printing what the real one does (recorded from 2.1.296):
// its terminal probes, Program Status reports (OSC 7501), a prompt box with a dim placeholder,
// the folder trust dialog, and the hooks it was given in --settings, posted to their server.
//
// It keeps its state in the folder it runs in, under .fake-claude/: log.jsonl (how it was
// started, each prompt it got, each signal) for the tests to read, and one file per session
// (its "transcript", which --resume needs). A file .fake-claude-untrusted in the folder makes it
// ask whether to trust the folder first.
//
// Prompts: "ask …" asks for permission first (1 or Enter: yes), "slow …" works until Escape,
// "link …" is answered with a link, anything else is answered at once. Its terminal's size is
// logged as it changes, so a test can tell where a cell is drawn.
//
// `claude auth status --json` reports a Claude subscription login (claude.ai), unless the
// environment has an API key, as the real one does; it logs nothing.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
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
    quit(0);
  });
}

async function hook(name, fields = {}) {
  const settings = arg('--settings');
  if (!settings) return;
  const url = JSON.parse(readFileSync(settings, 'utf8')).hooks[name]?.[0]?.hooks[0]?.url;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CORRALLM_HOOK_TOKEN ?? ''}`,
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
      `\r\n${'─'.repeat(60)}\r\n  ${state === 'working' ? '✻ Working… (esc to interrupt)' : '? for shortcuts'}`,
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
  if (prompt.startsWith('ask')) {
    become('blocked', ':kind=permission');
    lines.push('Bash(echo hello) · Do you want to proceed? 1. Yes  2. No');
    draw();
    return;
  }
  if (prompt.startsWith('slow')) return;
  setTimeout(() => void finish(), 300);
}

async function finish() {
  if (state !== 'working') return;
  const said = lines.at(-1)?.slice(2) ?? '';
  const reply = said.startsWith('link')
    ? 'See https://docs.example.com/hooks for more'
    : `You said: ${said}`;
  lines.push(`⏺ ${reply}`);
  await hook('Stop', { last_assistant_message: reply });
  if (state !== 'working') return;
  become('done');
  draw();
  log({ event: 'replied', text: reply });
}

function key(data) {
  // Answers to its terminal queries: the Program Status probe's says the terminal supports it.
  if (data.includes('\x1b]7501;?')) {
    reporting = true;
    if (state === 'starting' && !trusting) {
      become('idle');
      draw();
    }
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
