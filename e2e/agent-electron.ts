import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * macOS only: a copy of Electron's app bundle marked as an agent app (LSUIElement), so the app
 * under test never shows a Dock icon or takes the menu bar. Hiding the window and setting the
 * activation policy in the app still leave a moment at launch, before any app code runs, when
 * macOS shows the Dock icon; only the bundle's Info.plist decides that. The copy lives in the
 * temp folder, one per Electron version.
 */
function agentBundle(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const { version } = require('electron/package.json') as { version: string };
  return path.join(tmpdir(), `corrallm-e2e-electron-${version}`, 'Electron.app');
}

/** A temp cleaner may leave the executable while removing the bundle's metadata or loader. */
function completeBundle(bundle: string): boolean {
  return [
    'Contents/MacOS/Electron',
    'Contents/Info.plist',
    'Contents/PkgInfo',
    'Contents/Resources/default_app.asar',
    'Contents/_CodeSignature/CodeResources',
  ].every((file) => existsSync(path.join(bundle, file)));
}

/** The agent copy's executable, if it has been made (see `makeAgentElectron`). */
export function agentElectronExecutable(): string | undefined {
  const bundle = agentBundle();
  return bundle && completeBundle(bundle)
    ? path.join(bundle, 'Contents', 'MacOS', 'Electron')
    : undefined;
}

/**
 * Makes the agent copy once: an APFS clone of Electron.app, its Info.plist edited, re-signed ad
 * hoc.
 */
export function makeAgentElectron(): void {
  const bundle = agentBundle();
  if (!bundle || completeBundle(bundle)) return;
  // require('electron') is the path of its executable, inside Electron.app/Contents/MacOS.
  const source = path.resolve(require('electron') as string, '..', '..', '..');
  mkdirSync(path.dirname(bundle), { recursive: true });
  // Built next to its final place and renamed into it, so an interrupted run leaves no half copy.
  const work = mkdtempSync(`${path.dirname(bundle)}${path.sep}work-`);
  try {
    const copy = path.join(work, 'Electron.app');
    try {
      execFileSync('cp', ['-cR', source, copy]); // clone: instant, no extra disk
    } catch {
      execFileSync('cp', ['-R', source, copy]);
    }
    const plist = path.join(copy, 'Contents', 'Info.plist');
    execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', plist]);
    execFileSync('codesign', ['--force', '--sign', '-', copy]);
    if (existsSync(bundle)) renameSync(bundle, path.join(work, 'previous.app'));
    renameSync(copy, bundle);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
