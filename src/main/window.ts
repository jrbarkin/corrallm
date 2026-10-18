import path from 'node:path';

import { BrowserWindow } from 'electron';

/**
 * `hidden`: the window is never shown, but keeps rendering at full speed. For e2e tests, so the app
 * neither pops up on screen nor picks up the real mouse.
 */
export async function createMainWindow(
  url: string,
  options: { devTools: boolean; hidden: boolean },
) {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'corrallm',
    webPreferences: {
      // Built by Forge's Vite plugin next to main.cjs.
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: options.devTools,
      backgroundThrottling: !options.hidden,
    },
  });
  if (!options.hidden) {
    window.once('ready-to-show', () => {
      window.show();
    });
  }
  await window.loadURL(url);
  return window;
}
