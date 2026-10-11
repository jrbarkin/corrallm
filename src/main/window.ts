import path from 'node:path';

import { BrowserWindow } from 'electron';

export async function createMainWindow(url: string, options: { devTools: boolean }) {
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
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  await window.loadURL(url);
  return window;
}
