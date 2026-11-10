import { request } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookServer } from './hooks';
import type { HookEvent, HookHold, HookRegistration } from './hooks';

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

async function register(
  server: HookServer,
  listener: (event: HookEvent) => void,
  status?: (input: HookEvent) => void,
) {
  const registration = await server.register(listener, status);
  registrations.push(registration);
  return registration;
}

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

  it('refuses a foreign Host or any Origin before it reads the token', async () => {
    const server = new HookServer();
    const listener = vi.fn<(event: HookEvent) => void>();
    const status = vi.fn<(input: HookEvent) => void>();
    const { url, statusUrl, token } = await register(server, listener, status);
    const port = new URL(url).port;
    const auth = { Authorization: `Bearer ${token}` };

    // A page in a browser reaching the server through a name of its own (DNS rebinding).
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', 'localhost']) {
      expect((await post(url, '{}', { ...auth, Host: host })).status).toBe(403);
      // Refused as such, not for the missing token.
      expect((await post(url, '{}', { Host: host })).status).toBe(403);
      expect((await post(statusUrl, '{}', { ...auth, Host: host })).status).toBe(403);
    }
    // A browser's request, even from the server's own origin.
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${port}`]) {
      expect((await post(url, '{}', { ...auth, Origin: origin })).status).toBe(403);
      expect((await post(url, '{}', { Origin: origin })).status).toBe(403);
      expect((await post(statusUrl, '{}', { ...auth, Origin: origin })).status).toBe(403);
    }
    expect(listener).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();

    // Its own host, by either name.
    expect((await post(url, '{}', { ...auth, Host: `localhost:${port}` })).status).toBe(200);
    expect((await post(url, '{}', { ...auth, Host: `127.0.0.1:${port}` })).status).toBe(200);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(2);
    });
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

  it('hears a session’s status line input at its status path, with the same token', async () => {
    const server = new HookServer();
    const hooks = vi.fn<(event: HookEvent) => void>();
    const status = vi.fn<(input: HookEvent) => void>();
    const { url, statusUrl, token } = await register(server, hooks, status);
    expect(statusUrl).toBe(url.replace(/\/hook$/, '/status'));

    const input = { rate_limits: { five_hour: { used_percentage: 42 } } };
    expect((await post(statusUrl, JSON.stringify(input))).status).toBe(401);
    await expect(
      post(statusUrl, JSON.stringify(input), { Authorization: `Bearer ${token}` }),
    ).resolves.toEqual({ status: 200, text: '{}' });
    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(input);
    });
    expect(hooks).not.toHaveBeenCalled();

    // A session that does not listen for it: answered, but nobody hears it.
    const other = await register(server, hooks);
    expect((await post(statusUrl, '{}', { Authorization: `Bearer ${other.token}` })).status).toBe(
      200,
    );
    expect(hooks).not.toHaveBeenCalled();
  });

  describe('media type', () => {
    /** A POST with exactly these headers (the default Content-Type is not added). */
    function postWith(
      url: string,
      headers: Record<string, string>,
    ): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const sent = request(url, { method: 'POST', agent: false, headers }, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, text });
          });
        });
        sent.on('error', reject);
        sent.end('{}');
      });
    }

    it('takes only application/json (UTF-8 at most), before the token is read', async () => {
      const server = new HookServer();
      const listener = vi.fn<(event: HookEvent) => void>();
      const status = vi.fn<(input: HookEvent) => void>();
      const { url, statusUrl, token } = await register(server, listener, status);
      const auth = { Authorization: `Bearer ${token}` };
      for (const target of [url, statusUrl]) {
        for (const type of [
          'text/plain',
          'application/json; charset=latin1',
          'application/jsonx',
          'application/json; boundary=x',
        ]) {
          await expect(postWith(target, { ...auth, 'Content-Type': type })).resolves.toEqual({
            status: 415,
            text: '',
          });
        }
        await expect(postWith(target, { ...auth })).resolves.toEqual({ status: 415, text: '' });
        // Before the token: an unknown one is refused for its media type, not as unknown.
        await expect(
          postWith(target, { Authorization: 'Bearer 00ff', 'Content-Type': 'text/plain' }),
        ).resolves.toEqual({ status: 415, text: '' });
        for (const type of ['application/json', 'application/json; charset=utf-8']) {
          expect((await postWith(target, { ...auth, 'Content-Type': type })).status).toBe(200);
        }
      }
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalledTimes(2);
        expect(status).toHaveBeenCalledTimes(2);
      });
    });

    it('takes what Codex’s recorded curl command sends', async () => {
      const server = new HookServer();
      const { url, token } = await register(server, vi.fn());
      // curl -X POST -H "@header-file" -H "Content-Type: application/json" --data-binary @-
      const sent = await postWith(url, {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': 'curl/8.7.1',
      });
      expect(sent.status).toBe(200);
    });
  });

  describe('holding a request', () => {
    const asked = (event: HookEvent) => event.hook_event_name === 'PermissionRequest';
    const permission = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });

    /** A server whose registration holds PermissionRequests, collecting what it holds. */
    async function holding(options: { heldMs?: number } = {}) {
      const server = new HookServer(options);
      const holds: HookHold[] = [];
      const heard: HookEvent[] = [];
      const registration = await server.register(
        (event, hold) => {
          heard.push(event);
          if (hold) holds.push(hold);
        },
        undefined,
        asked,
      );
      registrations.push(registration);
      return {
        server,
        registration,
        holds,
        heard,
        auth: { Authorization: `Bearer ${registration.token}` },
      };
    }

    it('writes nothing until the session answers, then exactly that body, once', async () => {
      const { registration, holds, auth } = await holding();
      const reply = post(registration.url, permission, auth);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(1);
      });
      const [hold] = holds as [HookHold];
      expect(hold.ended).toBeUndefined();
      const body = { hookSpecificOutput: { hookEventName: 'PermissionRequest' } };
      expect(hold.answer(body)).toBe(true);
      await expect(reply).resolves.toEqual({ status: 200, text: JSON.stringify(body) });
      expect(hold.ended).toBe('answered');
      // A second answer, or a release, writes nothing.
      expect(hold.answer({ other: true })).toBe(false);
      expect(hold.release()).toBe(false);
      expect(hold.ended).toBe('answered');
    });

    it('answers {} to a request the session does not hold, and its listener hears it', async () => {
      const { registration, holds, heard, auth } = await holding();
      await expect(
        post(registration.url, JSON.stringify({ hook_event_name: 'Stop' }), auth),
      ).resolves.toEqual({ status: 200, text: '{}' });
      await vi.waitFor(() => {
        expect(heard).toHaveLength(1);
      });
      expect(holds).toHaveLength(0);
    });

    it('writes {} on release, and reports how a hold ended', async () => {
      const { registration, holds, auth } = await holding();
      const reply = post(registration.url, permission, auth);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(1);
      });
      const [hold] = holds as [HookHold];
      expect(hold.release()).toBe(true);
      await expect(reply).resolves.toEqual({ status: 200, text: '{}' });
      expect(hold.ended).toBe('released');
      expect(hold.answer({ late: true })).toBe(false);
    });

    it('releases an unanswered hold at its deadline', async () => {
      const { registration, holds, auth } = await holding({ heldMs: 60 });
      const reply = post(registration.url, permission, auth);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(1);
      });
      const [hold] = holds as [HookHold];
      expect(hold.deadline - hold.received).toBe(60);
      const ended = vi.fn();
      hold.onEnd(ended);
      await expect(reply).resolves.toEqual({ status: 200, text: '{}' });
      expect(hold.ended).toBe('deadline');
      expect(ended).toHaveBeenCalledWith('deadline');
      expect(hold.answer({ late: true })).toBe(false);
    });

    it('reports a request its client closed, and writes nothing after', async () => {
      const { registration, holds, auth } = await holding();
      const sent = request(registration.url, {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', ...auth },
      });
      sent.on('error', () => undefined);
      sent.end(permission);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(1);
      });
      const [hold] = holds as [HookHold];
      const ended = vi.fn();
      hold.onEnd(ended);
      sent.destroy();
      await vi.waitFor(() => {
        expect(hold.ended).toBe('closed');
      });
      expect(ended).toHaveBeenCalledWith('closed');
      expect(hold.answer({ late: true })).toBe(false);
      expect(hold.release()).toBe(false);
    });

    it('answers only the request a decision is for, whatever two bodies say', async () => {
      const { registration, holds, auth } = await holding();
      const first = post(registration.url, permission, auth);
      const second = post(registration.url, permission, auth);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(2);
      });
      const [one, two] = holds as [HookHold, HookHold];
      expect(two.answer({ for: 'second' })).toBe(true);
      await expect(second).resolves.toEqual({ status: 200, text: '{"for":"second"}' });
      expect(one.ended).toBeUndefined();
      one.release();
      await expect(first).resolves.toEqual({ status: 200, text: '{}' });
    });

    it('answers the 33rd concurrent hold of a registration {} at once', async () => {
      const { registration, holds, heard, auth } = await holding();
      const replies = Array.from({ length: 32 }, () => post(registration.url, permission, auth));
      await vi.waitFor(() => {
        expect(holds).toHaveLength(32);
      });
      await expect(post(registration.url, permission, auth)).resolves.toEqual({
        status: 200,
        text: '{}',
      });
      await vi.waitFor(() => {
        expect(heard).toHaveLength(33);
      });
      expect(holds).toHaveLength(32);
      for (const hold of holds) hold.release();
      await Promise.all(replies);
    });

    it('releases every hold with its registration', async () => {
      const { registration, holds, auth } = await holding();
      const reply = post(registration.url, permission, auth);
      await vi.waitFor(() => {
        expect(holds).toHaveLength(1);
      });
      registration.release();
      await expect(reply).resolves.toEqual({ status: 200, text: '{}' });
      expect(holds[0]?.ended).toBe('released');
    });

    it('never holds /status', async () => {
      const server = new HookServer();
      const registration = await server.register(vi.fn(), vi.fn(), () => true);
      registrations.push(registration);
      await expect(
        post(registration.statusUrl, '{}', { Authorization: `Bearer ${registration.token}` }),
      ).resolves.toEqual({ status: 200, text: '{}' });
    });
  });
});
