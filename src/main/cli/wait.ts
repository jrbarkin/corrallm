import type { WaitCommand } from './args';
import { cliFailure, mcpClient, WAIT_SLACK_MS } from './mcp-client';
export { TOKEN_VARIABLE, TOKEN_FILE_VARIABLE, URL_VARIABLE } from './mcp-client';

/** One long poll, preserving wait's JSON output and exit codes. */
export async function waitCommand(
  command: WaitCommand,
  { env, print }: { env: NodeJS.ProcessEnv; print: (line: string) => void },
): Promise<number> {
  try {
    const value = await mcpClient({
      env,
      allowEnvironmentToken: true,
      ...(command.tokenFile === undefined ? {} : { tokenFile: command.tokenFile }),
    }).call(
      'wait',
      {
        timeoutSeconds: command.timeout,
        ...(command.after === undefined ? {} : { after: command.after }),
        ...(command.for === undefined ? {} : { for: command.for }),
      },
      command.timeout * 1000 + WAIT_SLACK_MS,
    );
    if (!Array.isArray(value.messages)) {
      print(
        JSON.stringify({
          error: { code: 'unavailable', sentence: 'The server gave no messages.' },
        }),
      );
      return 3;
    }
    print(JSON.stringify(value));
    return value.messages.length > 0 ? 0 : 1;
  } catch (error) {
    const failure = cliFailure(error);
    print(JSON.stringify({ error: failure.error }));
    return failure.exitCode;
  }
}
