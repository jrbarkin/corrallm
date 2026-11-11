import { spawn } from 'node:child_process';
import path from 'node:path';

import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

function compare(stdin: string, committed: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts/lib/entitlements-equal.mjs'), path.join(root, committed)],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.on('close', resolve);
    child.stdin.end(stdin);
  });
}

const plist = (body: string) =>
  `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`;
const JIT = '<key>com.apple.security.cs.allow-jit</key><true/>';

it('accepts what the committed plist holds, whatever its layout and comments', async () => {
  expect(await compare(plist(`\n  ${JIT}\n`), 'build/entitlements.mac.plist')).toBe(0);
  expect(await compare(plist(JIT), 'build/entitlements.node.plist')).toBe(0);
});

it('refuses an extra entitlement, a missing one and a flipped value', async () => {
  const extra = '<key>com.apple.security.cs.disable-library-validation</key><true/>';
  expect(await compare(plist(JIT + extra), 'build/entitlements.mac.plist')).toBe(1);
  expect(await compare('', 'build/entitlements.mac.plist')).toBe(1);
  expect(
    await compare(
      plist('<key>com.apple.security.cs.allow-jit</key><false/>'),
      'build/entitlements.node.plist',
    ),
  ).toBe(1);
});
