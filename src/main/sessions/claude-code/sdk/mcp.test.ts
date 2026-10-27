import { describe, expect, it } from 'vitest';

import { mcpServer } from './mcp';

describe('mcpServer', () => {
  it('says how a server is, as /mcp shows it', () => {
    expect(
      mcpServer({
        name: 'github',
        status: 'connected',
        serverInfo: { name: 'github-mcp', version: '1.2.0' },
        scope: 'user',
        tools: [{ name: 'create_issue' }, { name: 'list_prs' }],
      }),
    ).toEqual({
      name: 'github',
      status: 'connected',
      server: 'github-mcp 1.2.0',
      scope: 'user',
      tools: 2,
    });
    expect(
      mcpServer({
        name: 'sentry',
        status: 'failed',
        error: 'Connection refused',
        scope: 'project',
      }),
    ).toEqual({ name: 'sentry', status: 'failed', error: 'Connection refused', scope: 'project' });
  });
});
