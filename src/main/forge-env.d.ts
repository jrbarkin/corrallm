// Constants injected by @electron-forge/plugin-vite at build time, one pair per renderer in
// forge.config.mts. Declared here rather than via '@electron-forge/plugin-vite/forge-vite-env'
// because that file types the dev server URL as `string`, but it is `undefined` outside
// `electron-forge start` (production and packaged builds).
export {};

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}
