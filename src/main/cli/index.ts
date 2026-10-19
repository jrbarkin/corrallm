import { nodeRefusal, USAGE_ERROR } from './node';

/*
 * `corrallm`'s entry: it checks the Node it runs on before anything else of the CLI loads. The CLI
 * (main.ts) is imported only once that Node will do, and its build inlines that import to run only
 * then (vite.cli.config.mts), so an older Node is refused in one sentence, exiting 64 as a command
 * line that can never work does, never with a stack trace from a module it lacks. Node's own
 * modules are required as the bundle loads, before this: the CLI's code imports one an older Node
 * lacks (node:sqlite) only where it uses it (node.test.ts runs the bundle as an older Node).
 */

const refusal = nodeRefusal(process.versions.node);
if (refusal === undefined) {
  void import('./main');
} else {
  process.stderr.write(`${refusal}\n`);
  // `wait`'s one line, for an orchestrator that reads it rather than stderr.
  if (process.argv[2] === 'wait') {
    process.stdout.write(`${JSON.stringify({ error: { code: 'invalid', sentence: refusal } })}\n`);
  }
  process.exitCode = USAGE_ERROR;
}
