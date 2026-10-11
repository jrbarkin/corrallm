/**
 * Pure URL helpers used by the main process security checks. No Electron imports, so they
 * can be unit-tested in plain Node.
 */

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

/** True only for plain https URLs (no credentials, default port) on an allowlisted host. */
export function isAllowedExternalUrl(
  raw: string,
  allowlist: ReadonlySet<string> = EXTERNAL_URL_ALLOWLIST,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    allowlist.has(url.hostname)
  );
}
