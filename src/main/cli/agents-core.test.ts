import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CanvasId } from '../../shared/canvas';
import { startApiServer } from '../api/mcp';
import type { ApiServer } from '../api/mcp';
import { createCore } from '../core/core';
import type { Core } from '../core/core';
import { keepCanvases } from '../core/store/test-store';
import { NO_DESKTOP } from '../core/test-registry';
import { legacyDirectories } from '../core/workspaces/test-directories';
import { fakeConnector } from '../sessions/test-fake';
import { parseCommand } from './args';
import type { AgentCommand } from './args';
import { agentCommand } from './agents';

it.skipIf(process.platform === 'win32')(
  'reads models and receives a fake native reply through the real MCP endpoint without registration',
  async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'agent-shell-core-'));
    let core: Core | undefined;
    let server: ApiServer | undefined;
    try {
      const canvas = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
      const profile = path.join(folder, 'profile');
      const project = path.join(folder, 'project');
      const file = path.join(folder, 'work.corral');
      await mkdir(profile, { mode: 0o700 });
      await mkdir(project);
      await writeFile(
        file,
        JSON.stringify({
          format: 'corrallm',
          version: 2,
          id: canvas,
          nodes: [
            {
              id: 'a',
              kind: 'agent',
              label: 'Builder',
              adapter: 'claude-code',
              connection: 'claude-code.sdk',
              position: { x: 0, y: 0 },
              settings: { 'claude-code': { model: 'haiku', effort: 'high' } },
            },
          ],
          links: [],
        }),
      );
      await keepCanvases(profile, { [canvas]: { file, project } });
      core = await createCore(
        {
          profile,
          app: { name: 'corrallm', version: '1' },
          distribution: 'local',
          check: true,
          directoryResolver: legacyDirectories,
          watchFolder: () => ({ close: () => undefined }),
          sessions: {
            connectors: {
              'claude-code.sdk': fakeConnector({
                mode: 'acceptEdits',
                script: { pause: 0, turns: [{ reply: 'Done' }] },
              }),
            },
            environment: () => Promise.resolve({}),
          },
        },
        NO_DESKTOP,
      );
      await core.engines.open(canvas);
      const answer = await core.tokenRequest(
        { version: 1, op: 'new', name: 'bot', hours: 1, access: 'write', canvases: [file] },
        { owner: 'app', url: null },
      );
      if (!answer.ok || answer.op === 'revoke') throw new Error('No fixture token');
      const tokenFile = path.join(folder, 'token');
      await writeFile(tokenFile, answer.token, { mode: 0o600 });
      const serving = core;
      server = await startApiServer({
        core,
        clientOf: (token) => serving.clientOf(token),
        port: 0,
      });
      const env = { CORRALLM_URL: server.url, CORRALLM_OUTSIDE_TOKEN_FILE: tokenFile };
      const output: string[] = [];
      const run = (args: string[]) =>
        agentCommand(parseCommand(args) as AgentCommand, {
          env,
          cwd: folder,
          print: (line) => {
            output.push(line);
          },
          say: () => undefined,
        });
      expect(await run(['agents', '--canvas', 'work.corral'])).toBe(0);
      expect(JSON.parse(output[0] ?? '')).toMatchObject({
        agents: [
          { id: 'a', model: 'haiku', effort: 'high', modelSource: 'agent', effortSource: 'agent' },
        ],
      });
      output.length = 0;
      await writeFile(path.join(folder, 'brief'), 'A brief from an ordinary shell');
      expect(
        await run([
          'ask',
          '--canvas',
          canvas,
          '--to',
          'Builder',
          '--brief',
          'brief',
          '--timeout',
          '5',
        ]),
      ).toBe(0);
      expect(JSON.parse(output[0] ?? '')).toMatchObject({
        from: 'agent:a',
        body: 'Done',
        turn: { status: 'completed' },
      });
      expect(output.join('\n')).not.toContain(answer.token);
    } finally {
      await server?.close();
      await core?.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
