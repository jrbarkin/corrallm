import { describe, expect, it, vi } from 'vitest';

import { appendRole, readDeveloperInstructions } from '../app-server/instructions';
import type { AppServer, AppServerOptions } from '../rpc';
import { nativeDeveloperInstructions } from './instructions';

const CONTEXT = { codex: '/bin/codex', cwd: '/work/project', env: { PATH: '/bin' } };

function fake(config: unknown) {
  const request = vi.fn(() => Promise.resolve({ config }));
  const close = vi.fn(() => Promise.resolve());
  const server = { request, close } as unknown as AppServer;
  const start = vi
    .fn<(options: AppServerOptions) => Promise<AppServer>>()
    .mockResolvedValue(server);
  return { request, close, start };
}

describe('native Codex developer instructions', () => {
  it('reads effective project settings without starting a thread or changing any user config', async () => {
    const { start, request, close } = fake({ developer_instructions: 'Native guidance' });
    expect(await nativeDeveloperInstructions(CONTEXT, { start })).toBe('Native guidance');
    expect(request.mock.calls).toEqual([['config/read', { cwd: CONTEXT.cwd }]]);
    expect(start).toHaveBeenCalledWith({
      ...CONTEXT,
      clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
      args: ['-c', 'projects={"/work/project"={trust_level="trusted"}}'],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves native instructions when adding or removing a role, including an empty base', () => {
    expect(appendRole('Native guidance', 'Review changes')).toBe(
      'Native guidance\n\nReview changes',
    );
    expect(appendRole('Native guidance', undefined)).toBe('Native guidance');
    expect(appendRole(undefined, 'Review changes')).toBe('Review changes');
    expect(appendRole(undefined, undefined)).toBe('');
    expect(appendRole('', undefined)).toBe('');
  });

  it.each([undefined, null, [], { developer_instructions: 42 }])(
    'refuses invalid config %j instead of silently overwriting native instructions',
    async (config) => {
      const { start, close } = fake(config);
      await expect(nativeDeveloperInstructions(CONTEXT, { start })).rejects.toThrow(
        /developer instructions/,
      );
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('propagates a config-read failure and still closes its private server', async () => {
    const { start, request, close } = fake({});
    request.mockRejectedValue(new Error('Config unavailable'));
    await expect(nativeDeveloperInstructions(CONTEXT, { start })).rejects.toThrow(
      'Config unavailable',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts an absent native setting as empty instructions', async () => {
    for (const config of [{}, { developer_instructions: null }]) {
      const { request } = fake(config);
      expect(await readDeveloperInstructions({ request }, CONTEXT.cwd)).toBeUndefined();
    }
  });
});
