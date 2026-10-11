import { describe, expect, it } from 'vitest';

import { allowedExternalUrl, originKey } from './url-policy';

describe('originKey', () => {
  it.each([
    ['app://MAIN_WINDOW/index.html', 'app://main_window'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['about:blank', 'about://'],
    ['not a url', null],
  ])('%s -> %s', (raw, expected) => {
    expect(originKey(raw)).toBe(expected);
  });
});

describe('allowedExternalUrl', () => {
  it.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://GITHUB.com/x', 'https://github.com/x'],
    // WHATWG parsing turns the backslash into a path separator; the normalized href is opened.
    ['https://github.com\\@evil.example', 'https://github.com/@evil.example'],
  ])('allows %s', (raw, expected) => {
    expect(allowedExternalUrl(raw)).toBe(expected);
  });

  it.each([
    'http://github.com/',
    'https://evil.example/',
    'https://github.com.evil.example/',
    'https://evil.example@github.com/',
    'https://user:pass@github.com/',
    'https://github.com:8443/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (raw) => {
    expect(allowedExternalUrl(raw)).toBeNull();
  });
});
