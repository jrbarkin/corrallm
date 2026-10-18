/**
 * Pure URL helpers used by the main process security checks. No Electron imports, so they
 * can be unit-tested in plain Node.
 */

import { MAX_LINK_LENGTH } from '../shared/ipc';

/** Hosts that links in the app may open in the user's default browser. Extend deliberately. */
export const EXTERNAL_URL_ALLOWLIST: ReadonlySet<string> = new Set(['github.com']);

/**
 * Returns `scheme://host[:port]` with a lower-cased host, or null for unparsable input.
 * Node's `URL#origin` is the string 'null' for custom schemes such as app://, so origin
 * comparisons must go through this helper instead.
 */
export function originKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Returns the normalized URL to open externally, or null unless it is a plain https URL (no
 * credentials, default port) on an allowlisted host. Always open the returned value, never the
 * raw input: OS URL handlers may parse oddities such as backslashes differently.
 */
export function allowedExternalUrl(
  raw: string,
  allowlist: ReadonlySet<string> = EXTERNAL_URL_ALLOWLIST,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const allowed =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    allowlist.has(url.hostname);
  return allowed ? url.href : null;
}

/** A link the user clicked, as the app may open it in their browser. */
export interface LinkTarget {
  /** The normalized URL: the one to open, never the raw input. */
  url: string;
  /** Its site, `scheme://host[:port]`: what "Always for this site" remembers. */
  origin: string;
  /** Its host (with a port, if it has one), as the dialog names it. */
  host: string;
  /** Whether it opens without asking (`allowedExternalUrl`). */
  allowlisted: boolean;
}

/** The hosts an http link may go to: this machine (a dev server, say). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * What a clicked link opens, normalized, or null unless it is https (any host, any port), or http
 * to this machine (localhost, 127.0.0.1), without credentials, and at most MAX_LINK_LENGTH long.
 * Hosts come out as WHATWG parsing gives them: lower-cased, and a look-alike Unicode name as its
 * punycode, so the dialog shows what will really open.
 */
export function linkTarget(
  raw: string,
  allowlist: ReadonlySet<string> = EXTERNAL_URL_ALLOWLIST,
): LinkTarget | null {
  if (raw.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const opens =
    url.username === '' &&
    url.password === '' &&
    url.hostname !== '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)));
  if (!opens || url.href.length > MAX_LINK_LENGTH) return null;
  return {
    url: url.href,
    origin: `${url.protocol}//${url.host}`,
    host: url.host,
    allowlisted: allowedExternalUrl(url.href, allowlist) !== null,
  };
}
