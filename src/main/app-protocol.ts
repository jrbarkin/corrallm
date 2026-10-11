import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

/**
 * Production builds serve the renderer from a privileged custom scheme (app://<name>/...)
 * instead of file://, per Electron's security checklist. This also lets us attach the CSP as
 * a real response header.
 */
export const APP_SCHEME = 'app';

/** Must run before the app's 'ready' event, and only once per app. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

/**
 * Maps `app://<host>/<path>` to an absolute file under `root`, or returns null when the URL is
 * for another scheme/host or would escape `root` (path traversal).
 */
export function resolveAppAsset(root: string, host: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host.toLowerCase() !== host) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  const target = path.join(root, pathname === '/' ? 'index.html' : pathname);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

/** Call after the app is ready. Serves files under `root` with the given CSP header. */
export function serveAppScheme(options: { root: string; host: string; csp: string }): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    const file = resolveAppAsset(options.root, options.host, request.url);
    if (file === null) return new Response(null, { status: 404 });

    let upstream: Response;
    try {
      // net.fetch reads through Electron's asar-aware loader.
      upstream = await net.fetch(pathToFileURL(file).toString(), {
        bypassCustomProtocolHandlers: true,
      });
    } catch {
      return new Response(null, { status: 404 });
    }

    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', options.csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  });
}
