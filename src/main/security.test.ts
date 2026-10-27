import { expect, it, vi } from 'vitest';
import type { Session } from 'electron';

vi.mock('electron', () => ({ app: { on: vi.fn() }, shell: { openExternal: vi.fn() } }));
import { hardenSession } from './security';

/*
 * The renderer's permissions (AGENTS.md: ALLOWED_PERMISSIONS stays empty). OS notifications are
 * main's native capability alone (B14 §9 C9): a page's Web Notifications stay denied by both
 * handlers, even for the app's own top-level frame, as every other permission is.
 */

const ORIGIN = 'app://main_window';

type Request = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame: boolean; requestingUrl: string },
) => void;
type Check = (contents: unknown, permission: string, origin: string) => boolean;

function hardened(): { request: Request; check: Check; device: () => boolean } {
  const handlers: { request?: Request; check?: Check; device?: () => boolean } = {};
  hardenSession(
    {
      setPermissionRequestHandler: (handler: Request) => {
        handlers.request = handler;
      },
      setPermissionCheckHandler: (handler: Check) => {
        handlers.check = handler;
      },
      setDevicePermissionHandler: (handler: () => boolean) => {
        handlers.device = handler;
      },
    } as unknown as Session,
    ORIGIN,
  );
  if (!handlers.request || !handlers.check || !handlers.device) throw new Error('not hardened');
  return { request: handlers.request, check: handlers.check, device: handlers.device };
}

it.each(['notifications', 'media', 'geolocation', 'clipboard-read', 'openExternal', 'midi'])(
  'denies the renderer %s, asked or checked, even from the app’s own top-level frame',
  (permission) => {
    const { request, check, device } = hardened();
    let granted: boolean | undefined;
    request(null, permission, (answer) => (granted = answer), {
      isMainFrame: true,
      requestingUrl: `${ORIGIN}/index.html`,
    });
    expect(granted).toBe(false);
    expect(check(null, permission, ORIGIN)).toBe(false);
    expect(device()).toBe(false);
  },
);
