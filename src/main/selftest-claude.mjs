// A tiny stand-in for the `claude` CLI that ships only for the packaged app's self-test
// (selftest.ts): it speaks just enough of the Agent SDK's protocol (JSON lines on stdin and
// stdout) for one query, without a model or a login. It answers the SDK's control requests
// (initialize first), and replies to each message with "ok" and a successful result.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const session = randomUUID();
const say = (message) => {
  process.stdout.write(`${JSON.stringify({ session_id: session, ...message })}\n`);
};
const usage = { input_tokens: 0, output_tokens: 0 };

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const initialize = message.request.subtype === 'initialize';
    process.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: initialize
            ? { commands: [], agents: [], models: [], account: {}, output_style: 'default' }
            : {},
        },
      })}\n`,
    );
  } else if (message.type === 'user') {
    const answered = message.uuid ? { user_message_uuids: [message.uuid] } : {};
    say({
      type: 'system',
      subtype: 'init',
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      model: 'self-test',
      permissionMode: 'default',
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: 'self-test',
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    });
    say({
      type: 'assistant',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'self-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    say({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      stop_reason: 'end_turn',
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      ...answered,
    });
  }
});
input.on('close', () => {
  process.exit(0);
});
