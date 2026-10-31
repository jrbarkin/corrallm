import path from 'node:path';

import { auditKill } from '../../test-kill';
import { SdkConnector } from './connector';

function connect(folder: string, log: string) {
  const sdk = new SdkConnector({
    clientApp: 'corrallm/test',
    findClaude: () => Promise.resolve(path.join(import.meta.dirname, 'fake-claude.mjs')),
  });
  return {
    start: (
      spec: Parameters<SdkConnector['start']>[0],
      host: Parameters<SdkConnector['start']>[1],
    ) =>
      sdk.start(
        {
          ...spec,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: 'sk-ant-test',
            CLAUDE_CONFIG_DIR: path.join(folder, 'config'),
            FAKE_CLAUDE_PROCESS_LOG: log,
          },
        },
        host,
      ),
  };
}

auditKill('claude-code', 'claude-code.sdk', connect);
// The Agent SDK spares background tasks on an interrupt (perTaskStopAffordance): the killed turn's
// own are stopped by id, an earlier turn's left running (B14 C3).
auditKill('claude-code', 'claude-code.sdk', connect, {
  earlier: 'background job',
  current: 'slow job',
  what: 'the background task the turn started',
});
