import { describe, expect, it } from 'vitest';

import { MAX_LINK_LENGTH } from '../shared/ipc';
import { allowedExternalUrl, linkTarget, loopbackUrl, originKey } from './url-policy';

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

describe('linkTarget', () => {
  it.each([
    [
      'https://docs.example.com/queues?a=1#b',
      {
        url: 'https://docs.example.com/queues?a=1#b',
        origin: 'https://docs.example.com',
        host: 'docs.example.com',
        allowlisted: false,
      },
    ],
    // Normalized: the host lower-cased, the backslash a path separator; opened as normalized.
    [
      'https://Docs.Example.com\\@evil.example',
      {
        url: 'https://docs.example.com/@evil.example',
        origin: 'https://docs.example.com',
        host: 'docs.example.com',
        allowlisted: false,
      },
    ],
    // A port is part of the site.
    [
      'https://staging.example.com:8443/x',
      {
        url: 'https://staging.example.com:8443/x',
        origin: 'https://staging.example.com:8443',
        host: 'staging.example.com:8443',
        allowlisted: false,
      },
    ],
    // A look-alike name is shown as what it is (punycode).
    [
      'https://exаmple.com/',
      {
        url: 'https://xn--exmple-4nf.com/',
        origin: 'https://xn--exmple-4nf.com',
        host: 'xn--exmple-4nf.com',
        allowlisted: false,
      },
    ],
    [
      'http://localhost:5173/',
      {
        url: 'http://localhost:5173/',
        origin: 'http://localhost:5173',
        host: 'localhost:5173',
        allowlisted: false,
      },
    ],
    [
      'http://127.0.0.1:8080/health',
      {
        url: 'http://127.0.0.1:8080/health',
        origin: 'http://127.0.0.1:8080',
        host: '127.0.0.1:8080',
        allowlisted: false,
      },
    ],
    [
      'https://github.com/owner/repo',
      {
        url: 'https://github.com/owner/repo',
        origin: 'https://github.com',
        host: 'github.com',
        allowlisted: true,
      },
    ],
  ])('opens %s, as %o', (raw, expected) => {
    expect(linkTarget(raw)).toEqual(expected);
  });

  it.each([
    'http://docs.example.com/',
    'http://127.0.0.2/',
    'http://localhost.evil.example/',
    'https://user:pass@docs.example.com/',
    'https://user@docs.example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'app://main_window/index.html',
    'ftp://example.com/',
    'vscode://file/etc/passwd',
    'not a url',
    `https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}`,
  ])('refuses %s', (raw) => {
    expect(linkTarget(raw)).toBeNull();
  });

  it('is allowlisted only on the default port', () => {
    expect(linkTarget('https://github.com:8443/')?.allowlisted).toBe(false);
  });
});

describe('loopbackUrl', () => {
  it.each([
    ['http://127.0.0.1:4100/mcp', 'http://127.0.0.1:4100/mcp'],
    ['http://localhost:4100/mcp', 'http://localhost:4100/mcp'],
    ['HTTP://LOCALHOST:4100/mcp', 'http://localhost:4100/mcp'],
  ])('takes corrallm’s server on this machine: %s', (raw, expected) => {
    expect(loopbackUrl(raw)).toBe(expected);
  });

  it.each([
    'http://example.com/mcp',
    'https://127.0.0.1:4100/mcp',
    'http://127.0.0.2:4100/mcp',
    'http://[::1]:4100/mcp',
    'http://user:pass@127.0.0.1:4100/mcp',
    'http://127.0.0.1:4100/mcp?token=1',
    'http://127.0.0.1:4100/mcp?',
    'http://127.0.0.1:4100/mcp#here',
    'http://127.0.0.1.example.com/mcp',
    'not a url',
  ])('refuses anywhere else a token could go: %s', (raw) => {
    expect(loopbackUrl(raw)).toBeNull();
  });
});
