import path from 'node:path';

import { auditKill } from '../../test-kill';
import { SdkConnector } from './connector';

auditKill('claude-code', 'claude-code.sdk', (folder, log) => {
  const sdk = new SdkConnector({
    clientApp: 'corrallm/test',
    findClaude: () => Promise.resolve(path.join(import.meta.dirname, 'fake-claude.mjs')),
  });
  return {
    start: (spec, host) =>
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
});
