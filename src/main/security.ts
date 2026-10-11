import { app, shell, type Session, type WebFrameMain } from 'electron';

import { isAllowedExternalUrl, originKey } from './url-policy';

/** Permissions the renderer may be granted. Empty: everything is denied. Extend deliberately. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set<string>();

/**
 * True when an IPC message comes from the top-level frame of our own renderer.
 * Read `event.senderFrame` synchronously: it becomes null once the frame navigates or is destroyed.
 */
export function isTrustedSender(frame: WebFrameMain | null, trustedOrigin: string): boolean {
  if (frame === null || frame.detached || frame.parent !== null) return false;
  return originKey(frame.origin) === trustedOrigin;
}

/** Deny-by-default permission handling. Electron grants every permission unless told otherwise. */
export function hardenSession(session: Session, trustedOrigin: string): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(
      ALLOWED_PERMISSIONS.has(permission) &&
        details.isMainFrame &&
        originKey(details.requestingUrl) === trustedOrigin,
    );
  });
  session.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && originKey(requestingOrigin) === trustedOrigin,
  );
  session.setDevicePermissionHandler(() => false);
}

function openExternalIfAllowed(url: string): void {
  if (isAllowedExternalUrl(url)) void shell.openExternal(url);
}

/**
 * Applies to every WebContents the app ever creates. Call before creating any window.
 * - Navigation away from the app's origin is blocked (allowlisted links open in the browser).
 * - New windows are never created by the renderer (allowlisted links open in the browser).
 * - <webview> attachment is refused.
 */
export function installNavigationGuards(trustedOrigin: string): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => {
      if (originKey(event.url) === trustedOrigin) return;
      event.preventDefault();
      openExternalIfAllowed(event.url);
    });
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || originKey(event.url) === trustedOrigin) return;
      event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfAllowed(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}
