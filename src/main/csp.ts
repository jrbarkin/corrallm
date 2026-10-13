/**
 * Content-Security-Policy for the renderer, sent as a response header:
 * - production: by the app:// protocol handler (src/main/app-protocol.ts)
 * - development: by the Vite dev server (vite.renderer.config.mts)
 */

/**
 * The two inline styles a terminal (xterm.js 6.0.0, in a Terminal agent's view) writes, by hash:
 * its scrollbar's <style>, empty, then with the colours of its theme
 * (src/renderer/terminal/screen.ts: THEME). Only these exact texts are allowed; a change to
 * either (another theme, another xterm.js) shows as a CSP violation in e2e/terminal.e2e.ts.
 */
const TERMINAL_STYLES = [
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  "'sha256-FUB/YC7vo6BYz3d6Il7Cf/XewLOEia2ceMMOUVfX8sk='",
];

export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' ${TERMINAL_STYLES.join(' ')}`,
  // Vite inlines small assets as data: URIs.
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Development only. Relaxed exactly as far as Vite HMR needs:
 * - script-src 'unsafe-inline': @vitejs/plugin-react's inline React Refresh preamble
 * - style-src 'unsafe-inline': Vite injects CSS as <style> tags during HMR
 * - connect-src ws://localhost:*: the HMR websocket
 */
export const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:*",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
