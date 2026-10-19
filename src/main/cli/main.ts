import { memoryText, runChecks, SELFTEST_TIMEOUT_MS, selfTestChecks } from '../core/selftest';
import { parseCommand, USAGE, UsageError } from './args';
import type { Command } from './args';
import { USAGE_ERROR } from './node';
import { serveCommand } from './serve';
import { waitCommand } from './wait';

/*
 * `corrallm`, one Node CLI on the same code as the app's core, run under plain Node rather than
 * Electron (decision 20h; API Spec §8.6). `pnpm build:cli` builds it (vite.cli.config.mts) into
 * dist-cli/corrallm.cjs, and `pnpm corrallm` runs it: its entry (index.ts) imports this once the
 * Node it runs on will do. `serve` runs the core headless, with its MCP
 * server for orchestrators outside corrallm (serve.ts); `wait` waits for what comes to one
 * (wait.ts). A command line that isn't one of theirs exits 64 (EX_USAGE), apart from every code
 * `wait` exits with, saying why on stderr (and, for `wait`, as its one JSON line). With
 * CORRALLM_NATIVE_SELFTEST=1 it runs the native self-test instead: the core's checks, as the app
 * runs them in its core process, exiting the same way: 0 once every check passed, 2 if one failed,
 * 3 on a timeout, 4 on an uncaught error.
 */

/** Exits with `code` once what was printed has been written out (a pipe may lag). */
function exit(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

async function selfTest(): Promise<void> {
  const fail = (kind: string) => (error: unknown) => {
    console.error(`[native-selftest] ${kind}:`, error);
    exit(4);
  };
  process.on('uncaughtException', fail('uncaught exception'));
  process.on('unhandledRejection', fail('unhandled rejection'));
  const timeout = setTimeout(() => {
    console.error('[native-selftest] timed out');
    exit(3);
  }, SELFTEST_TIMEOUT_MS);

  // Since this process started: Node's own start, and loading the bundle.
  const startup = Math.round(performance.now());
  console.log(`[native-selftest] cli: ready ${String(startup)} ms after start (${memoryText()})`);
  const results = await runChecks(selfTestChecks({ packaged: false }));
  for (const { ok, said } of results) {
    if (ok) console.log(`[native-selftest] cli: ${said}`);
    else console.error(`[native-selftest] cli: ${said}`);
  }
  console.log(`[native-selftest] cli: after the checks, ${memoryText()}`);
  clearTimeout(timeout);
  exit(results.every(({ ok }) => ok) ? 0 : 2);
}

/**
 * Resolves once the process is told to stop: Ctrl-C, a kill, or its terminal closing. It goes on
 * hearing them until the process exits, so that being told again while it stops (a second Ctrl-C
 * as sessions close) never kills it before it has let the profile go: `again` hears each.
 */
function stopSignal(again: () => void): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    let told = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        if (told) again();
        told = true;
        resolve(signal);
      });
    }
  });
}

async function run(command: Command): Promise<number> {
  switch (command.command) {
    case 'serve':
      // What goes wrong where nothing waits for it is said, and the server goes on.
      process.on('unhandledRejection', (error) => {
        console.error('corrallm serve: unhandled rejection:', error);
      });
      // Its terminal closed, or the reader of its stderr gone (a pipe to `tee` stopped first):
      // what it says is lost, and it still stops cleanly.
      process.stderr.on('error', () => undefined);
      return serveCommand(command, {
        env: process.env,
        stderr: process.stderr,
        app: { name: 'corrallm', version: CORRALLM_VERSION },
        stopped: stopSignal(() => {
          process.stderr.write(
            'corrallm serve: stopping already: it ends once its sessions have closed.\n',
          );
        }),
      });
    case 'wait':
      return waitCommand(command, {
        env: process.env,
        print: (line) => {
          process.stdout.write(`${line}\n`);
        },
      });
  }
}

if (process.env.CORRALLM_NATIVE_SELFTEST === '1') {
  void selfTest();
} else {
  let command: Command | undefined;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`corrallm: ${error.message}\n\n${USAGE}`);
    // `wait`'s one line, for an orchestrator that reads it rather than stderr.
    if (process.argv[2] === 'wait') {
      process.stdout.write(
        `${JSON.stringify({ error: { code: 'invalid', sentence: error.message } })}\n`,
      );
    }
    exit(USAGE_ERROR);
  }
  if (command) {
    run(command).then(exit, (error: unknown) => {
      console.error(`corrallm ${command.command}:`, error);
      exit(4);
    });
  }
}
