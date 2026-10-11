import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: {}, protocol: {} }));

import { resolveAppAsset } from './app-protocol';

const root = path.resolve('/srv/app/renderer/main_window');
const resolve = (url: string) => resolveAppAsset(root, 'main_window', url);

describe('resolveAppAsset', () => {
  it.each([
    ['app://main_window/', 'index.html'],
    ['app://main_window/index.html', 'index.html'],
    ['app://MAIN_WINDOW/assets/index.js', 'assets/index.js'],
    ['app://main_window/assets/a%20b.css', 'assets/a b.css'],
  ])('serves %s', (url, file) => {
    expect(resolve(url)).toBe(path.join(root, file));
  });

  it.each([
    'app://other_window/index.html',
    'https://main_window/index.html',
    'app://main_window/%00.js',
    'app://main_window/%E0%A4%A',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolve(url)).toBeNull();
  });

  // Whatever the platform's path semantics, a result must never leave the root.
  it.each([
    'app://main_window/../secret',
    'app://main_window/..%2f..%2fsecret',
    'app://main_window/%2e%2e/secret',
    'app://main_window/%5c..%5c..%5csecret',
    'app://main_window/C:/Windows/win.ini',
    'app://main_window/C:%5cWindows%5cwin.ini',
    'app://main_window/%5c%5cserver%5cshare',
  ])('stays inside the root for %s', (url) => {
    const file = resolve(url);
    if (file === null) return;
    const relative = path.relative(root, file);
    expect(relative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });
});
