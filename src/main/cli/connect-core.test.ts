import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCore } from '../core/core';
import type { Core } from '../core/core';
import { NO_DESKTOP } from '../core/test-registry';
import { serveTokenSocket } from '../core/token-socket';
import type { TokenSocket } from '../core/token-socket';
import { asHuman } from '../core/gui';
import * as host from '../core/host/node';
import { connectCommand } from './connect';
vi.mock('../sessions/installed', () => ({ installedClis: () => Promise.resolve({}) }));
it.skipIf(process.platform === 'win32')(
  'connects through the private socket and waits for Allow without exposing a bearer',
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'oc-')));
    let core: Core | undefined;
    let socket: TokenSocket | undefined;
    try {
      const profile = path.join(root, 'profile');
      const folder = path.join(root, 'project');
      const into = path.join(root, 'private', 'orchestrator.token');
      await mkdir(profile, { mode: 0o700 });
      await mkdir(folder);
      await mkdir(path.dirname(into), { mode: 0o700 });
      vi.spyOn(host, 'appProfile').mockReturnValue(profile);
      core = await createCore(
        { profile, app: { name: 'corrallm', version: '1' }, distribution: 'local', check: true },
        NO_DESKTOP,
      );
      const serving = core;
      socket = await serveTokenSocket({
        profile,
        answer: (request, signal) =>
          serving.tokenRequest(
            request,
            { owner: 'app', url: 'http://127.0.0.1:47104/mcp' },
            signal,
          ),
      });
      const printed: string[] = [];
      const command = connectCommand(
        { command: 'connect', folder, into, timeout: 60 },
        {
          env: {},
          cwd: folder,
          say: (line) => {
            printed.push(line);
          },
          loginEnv: {},
        },
      );
      const human = asHuman('host');
      let id = '';
      await vi.waitFor(async () => {
        const settings = await serving.call('settings.get', {}, human);
        if (!settings.ok) throw new Error('No settings');
        id = settings.value.orchestrators?.pending[0]?.id ?? '';
        expect(id).not.toBe('');
      });
      expect(printed).toEqual([]);
      expect(
        await serving.call(
          'settings.set',
          { orchestrator: { action: 'allow', id, withoutApprovals: false } },
          human,
        ),
      ).toMatchObject({ ok: true });
      expect(await command).toBe(0);
      const bearer = (await readFile(into, 'utf8')).trim();
      expect(serving.clientOf(bearer)).toMatchObject({ kind: 'outside', access: 'write' });
      expect(printed.join('\n')).not.toContain(bearer);
      expect(printed.join('\n')).toContain('CORRALLM_OUTSIDE_TOKEN_FILE');
    } finally {
      await socket?.close();
      await core?.close();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);
