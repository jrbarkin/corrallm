import type { Session } from 'electron';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, shell: {} }));

import { hardenSession } from './security';

type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;

it('native notifications grant the renderer no notification permission through either handler', () => {
  const requested = vi.fn<(handler: Request | null) => void>();
  const checked = vi.fn<(handler: Check | null) => void>();
  hardenSession(
    {
      setPermissionRequestHandler: requested,
      setPermissionCheckHandler: checked,
      setDevicePermissionHandler: vi.fn(),
    } as unknown as Session,
    'app://main_window',
  );
  const request = requested.mock.calls[0]?.[0];
  const check = checked.mock.calls[0]?.[0];
  if (!request || !check) throw new Error('permission handlers were not installed');
  const contents = {} as Parameters<Request>[0];
  const details = {
    isMainFrame: true,
    requestingUrl: 'app://main_window/index.html',
  } as Parameters<Request>[3];
  const answer = vi.fn<(allowed: boolean) => void>();
  request(contents, 'notifications', answer, details);
  expect(answer).toHaveBeenCalledExactlyOnceWith(false);
  expect(check(contents, 'notifications', 'app://main_window', { isMainFrame: true })).toBe(false);
});
