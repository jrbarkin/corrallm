import type { IncomingMessage } from 'node:http';

/*
 * What both of corrallm's local servers (MCP, api/mcp.ts; hooks, sessions/terminal/hooks.ts)
 * check before anything else, the token included. They listen only on 127.0.0.1, so a web page
 * reaches them only by getting a browser to send the request: through a name of its own that
 * resolves to 127.0.0.1 (DNS rebinding), which sends a Host other than theirs, or with an Origin
 * header, which a browser always sends a page's cross-origin request with and no CLI sends.
 */

/** Why a request to a loopback server is refused before its token is read, if it is. */
export function foreignRequest(request: IncomingMessage): string | undefined {
  const port = String(request.socket.localPort);
  const { host, origin } = request.headers;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return `Invalid Host header: ${host ?? 'none'}`;
  }
  if (origin !== undefined) return `Requests from a web page are refused (Origin: ${origin})`;
  return undefined;
}
