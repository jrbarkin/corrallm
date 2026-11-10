import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

/*
 * The packaged headless check (B30 C7), pinned: both packaged gates and the installed-package
 * gate run it against the shipped command with an empty PATH, seeding the throwaway profile with a
 * test-only bundle that is never packed. The round trip itself runs in the gates (check-macos.sh,
 * linux-smoke.sh); here, only what keeps it honest.
 */

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

it('is run by the macOS packaged gate and the Linux packaged and installed gates', async () => {
  const macos = await read('scripts/check-macos.sh');
  expect(macos).toMatch(
    /bash scripts\/lib\/headless-smoke\.sh "\$command" "\$app\/Contents\/Resources\/cli\/node" "\$PWD\/dist-check\/seed-profile\.cjs"/,
  );
  const smoke = await read('scripts/lib/linux-smoke.sh');
  expect(smoke).toMatch(/headless-smoke\.sh" "\$command" "\$shipped_node" "\$seed"/);
  // linux-smoke.sh is what both check-linux.sh (packaged) and check-linux-packages.sh (installed)
  // run, with the seeding bundle built in the container and carried beside the installers.
  expect(await read('scripts/lib/linux-installed.sh')).toContain(
    'linux-smoke.sh /usr/lib/corrallm/corrallm /usr/bin/corrallm /checks/seed-profile.cjs',
  );
  const workspace = await read('scripts/lib/linux-workspace.sh');
  expect(workspace).toContain('pnpm build:seed');
  expect(workspace).toContain('headless-smoke.sh');
  expect(workspace).toContain('cp dist-check/seed-profile.cjs "$artifacts/"');
});

it('runs every call of the shipped command and its Node with an empty PATH, on a pseudo-terminal where it needs one', async () => {
  const script = await read('scripts/lib/headless-smoke.sh');
  const lines = script.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  // Each line that runs the command or the Node goes through env -i with PATH empty.
  for (const line of lines.filter((one) => /"\$(command|node)"/.test(one))) {
    if (/^\s*(?:\[|if |case |real=|shipped=|\w+=\$\(printf)/.test(line)) continue;
    if (/\[ -[xf] /.test(line)) continue;
    expect(line, line).toMatch(/env -i PATH= |run "\$node"|run "\$command"/);
  }
  expect(script).toContain('run() { env -i PATH= HOME="$home" "$@"; }');
  // serve, token new, wait, token revoke and the SIGTERM, in this order.
  const order = ['serve --profile', 'token new', 'wait --timeout 1', 'token revoke', 'kill -TERM'];
  const at = order.map((needle) =>
    needle === 'kill -TERM' ? script.lastIndexOf(needle) : script.indexOf(needle),
  );
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // The token commands run only on a terminal.
  expect(script).toMatch(/on_terminal token new/);
  expect(script).toMatch(/on_terminal token revoke/);
  // The two exits the gate depends on.
  expect(script).toMatch(/-eq 1 \].*expected 1/);
  expect(script).toMatch(/-eq 2 \].*expected 2/);
});

it('seeds with a test-only bundle that is built outside the app, never packed, and checked absent', async () => {
  const forge = await read('forge.config.mts');
  expect(forge).not.toContain('dist-check');
  expect(forge).not.toContain('seed-profile');
  const config = await read('vite.seed.config.mts');
  expect(config).toContain("outDir: 'dist-check'");
  expect(await read('.gitignore')).toContain('dist-check/');
  const script = await read('scripts/lib/headless-smoke.sh');
  expect(script).toContain('find "$shipped" -name \'seed-profile*\'');
  // Run by the shipped Node, by absolute path: an installed package's image has no other Node.
  expect(script).toContain('run "$node" "$seed"');
});
