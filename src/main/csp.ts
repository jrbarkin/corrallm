/**
 * Content-Security-Policy for the renderer, sent as a response header:
 * - production: by the app:// protocol handler (src/main/app-protocol.ts)
 * - development: by the Vite dev server (vite.renderer.config.mts)
 */

export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
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
