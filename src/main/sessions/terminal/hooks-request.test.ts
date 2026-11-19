import { EventEmitter } from 'node:events';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { afterEach, expect, it, vi } from 'vitest';

import { HookServer } from './hooks';
import type { HookEvent, HookHold, HookRegistration } from './hooks';

const http = vi.hoisted(() => ({ receive: undefined as RequestListener | undefined }));
vi.mock('node:http', () => ({
  createServer: (receive: RequestListener) => {
    http.receive = receive;
    return {
      once: vi.fn(),
      listen: (_port: number, _host: string, ready: () => void) => {
        ready();
      },
      address: () => ({ port: 47104 }),
      close: vi.fn(),
      closeAllConnections: vi.fn(),
    };
  },
}));

const registrations: HookRegistration[] = [];
afterEach(() => {
  for (const registration of registrations.splice(0)) registration.release();
  vi.useRealTimers();
});

/** A request whose headers arrived, with its body still under the sender's control. */
function begin(registration: HookRegistration, route: '/hook' | '/status') {
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: route,
    headers: {
      host: '127.0.0.1:47104',
      authorization: `Bearer ${registration.token}`,
      'content-type': 'application/json',
    },
    socket: { localPort: 47104 },
    resume: vi.fn(),
  });
  const response = Object.assign(new EventEmitter(), {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  });
  if (http.receive === undefined) throw new Error('No hook server');
  http.receive(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return {
    response,
    finish: () => {
      request.emit('data', Buffer.from('{"hook_event_name":"PermissionRequest"}'));
      request.emit('end');
    },
  };
}

it.each(['/hook', '/status'] as const)(
  'accepts %s bodies only while their registration is current',
  async (route) => {
    const server = new HookServer();
    const listener = vi.fn();
    const status = vi.fn();
    const holds = vi.fn(() => true);
    const first = await server.register(listener, status, holds);
    const current = await server.register(listener, status);
    registrations.push(first, current);
    const pending = begin(first, route);
    expect(pending.response.end).not.toHaveBeenCalled();
    first.release();
    pending.finish();
    expect(pending.response.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(listener).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(holds).not.toHaveBeenCalled();

    const live = begin(current, route);
    live.finish();
    expect(live.response.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(route === '/hook' ? listener : status).toHaveBeenCalledTimes(1);
  },
);

it('answers a held request only before its deadline, even before a delayed timer runs', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const server = new HookServer({ heldMs: 20_000 });
  const listener = vi.fn<(event: HookEvent, hold?: HookHold) => void>();
  const registration = await server.register(listener, undefined, () => true);
  registrations.push(registration);
  const early = begin(registration, '/hook');
  early.finish();
  const late = begin(registration, '/hook');
  late.finish();
  const first = listener.mock.calls[0]?.[1];
  const second = listener.mock.calls[1]?.[1];
  if (first === undefined || second === undefined) throw new Error('No held requests');
  vi.setSystemTime(19_999);
  expect(first.answer({ decision: 'allow' })).toBe(true);
  expect(early.response.end).toHaveBeenCalledWith('{"decision":"allow"}');
  vi.setSystemTime(20_000);
  expect(second.answer({ decision: 'allow' })).toBe(false);
  expect(late.response.end).toHaveBeenCalledExactlyOnceWith('{}');
  expect(second.ended).toBe('deadline');
});
