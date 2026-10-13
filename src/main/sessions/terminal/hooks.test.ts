import { request } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOOK_TOKEN, hookSettings, HookServer } from './hooks';
import type { HookEvent, HookRegistration } from './hooks';

/** Posts `body` to `url` as a hook would; resolves with the status and what came back. */
function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      // A connection of its own each time: one cut short is never reused.
      { method, agent: false, headers: { 'Content-Type': 'application/json', ...headers } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    sent.on('error', reject);
    sent.end(body);
  });
}

let registrations: HookRegistration[] = [];
afterEach(() => {
  for (const registration of registrations) registration.release();
  registrations = [];
});

async function register(server: HookServer, listener: (event: HookEvent) => void) {
  const registration = await server.register(listener);
  registrations.push(registration);
  return registration;
}

describe('hookSettings', () => {
  it('posts the events corrallm follows to its server, with the token from the environment', () => {
    const settings = hookSettings('http://127.0.0.1:4000/hook');
    expect(Object.keys(settings.hooks)).toEqual([
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PostModelSwitch',
      'PermissionRequest',
      'Notification',
      'PreToolUse',
    ]);
    // Before a tool runs, only the two that ask the user: its questions, and a plan to approve.
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: settings.hooks.Stop?.[0]?.hooks },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:4000/hook',
            headers: { Authorization: `Bearer $${HOOK_TOKEN}` },
            allowedEnvVars: [HOOK_TOKEN],
            timeout: 5,
          },
        ],
      },
    ]);
  });
});

describe('HookServer', () => {
  it('routes each event to the session whose token it carries, answering with no decision', async () => {
    const server = new HookServer();
    const one = vi.fn<(event: HookEvent) => void>();
    const other = vi.fn<(event: HookEvent) => void>();
    const first = await register(server, one);
    const second = await register(server, other);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
    expect(second.url).toBe(first.url);
    expect(second.token).not.toBe(first.token);

    const event = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Done.' };
    await expect(
      post(first.url, JSON.stringify(event), { Authorization: `Bearer ${first.token}` }),
    ).resolves.toEqual({ status: 200, text: '{}' });
    await vi.waitFor(() => {
      expect(one).toHaveBeenCalledWith(event);
    });
    expect(other).not.toHaveBeenCalled();
  });

  it('refuses requests without a known token, other paths and methods, and huge bodies', async () => {
    const server = new HookServer();
    const listener = vi.fn<(event: HookEvent) => void>();
    const { url, token } = await register(server, listener);
    const auth = { Authorization: `Bearer ${token}` };

    expect((await post(url, '{}')).status).toBe(401);
    expect((await post(url, '{}', { Authorization: 'Bearer 00ff' })).status).toBe(401);
    expect((await post(url.replace('/hook', '/other'), '{}', auth)).status).toBe(404);
    expect((await post(url, '', auth, 'GET')).status).toBe(404);
    const huge = JSON.stringify({ prompt: 'x'.repeat(5 * 1024 * 1024) });
    await post(url, huge, auth).then(
      ({ status }) => {
        expect(status).toBe(413);
      },
      // Or the connection is cut while the body is still being sent.
      () => undefined,
    );
    // Not JSON, or not an object: answered, but nobody hears it.
    expect((await post(url, 'not json', auth)).status).toBe(200);
    expect((await post(url, '[1]', auth)).status).toBe(200);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops hearing a session once released, and closes when no session is left', async () => {
    const server = new HookServer();
    const listener = vi.fn<(event: HookEvent) => void>();
    const registration = await server.register(listener);
    registration.release();
    await expect(
      post(registration.url, '{}', { Authorization: `Bearer ${registration.token}` }),
    ).rejects.toThrow(/ECONNREFUSED|socket hang up|ECONNRESET/);

    // It starts again for the next session.
    const again = await register(server, listener);
    expect((await post(again.url, '{}', { Authorization: `Bearer ${again.token}` })).status).toBe(
      200,
    );
  });
});
