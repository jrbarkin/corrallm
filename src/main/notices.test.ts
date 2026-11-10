import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_LICENSES,
  BUNDLES,
  bundledPackages,
  joinNotices,
  packageOfModule,
  recordBundle,
} from '../../build/notices';

const root = path.resolve(import.meta.dirname, '../..');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function project() {
  const cache = path.join(root, 'node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'notices-'));
  folders.push(folder);
  const notices = path.join(folder, 'notices');
  await mkdir(notices);
  return { folder, notices };
}

/** An installed package, pnpm style, and the id Rollup gives one of its modules. */
async function install(
  folder: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(
    folder,
    'node_modules/.pnpm',
    `${name.replace('/', '+')}@1/node_modules`,
    name,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', ...manifest }),
  );
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
  return path.join(dir, 'index.js');
}

async function bundles(notices: string, modules: string[], which: readonly string[] = BUNDLES) {
  for (const bundle of which)
    await writeFile(
      path.join(notices, `${bundle}.json`),
      JSON.stringify(modules.map((id) => path.dirname(id))),
    );
}

describe('packageOfModule', () => {
  it.each([
    [
      '/p/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js',
      'react',
      '/p/node_modules/.pnpm/react@19.0.0/node_modules/react',
    ],
    [
      '/p/node_modules/.pnpm/x/node_modules/@xterm/xterm/lib/a.js?raw',
      '@xterm/xterm',
      '/p/node_modules/.pnpm/x/node_modules/@xterm/xterm',
    ],
    ['/p/node_modules/zod/v4/core.js', 'zod', '/p/node_modules/zod'],
    [
      '/r/node_modules/.cache/probes/release-dry-run-x/clone/node_modules/.pnpm/react@19/node_modules/react/index.js',
      'react',
      '/r/node_modules/.cache/probes/release-dry-run-x/clone/node_modules/.pnpm/react@19/node_modules/react',
    ],
  ])('names the package of %s', (id, name, dir) => {
    expect(packageOfModule(id)).toEqual({ name, dir });
  });

  it.each([
    '/p/src/renderer/App.tsx',
    '/r/node_modules/.cache/probes/release-dry-run-x/clone/src/main/index.ts',
    '\0commonjsHelpers.js',
    '\0vite/preload-helper.js',
    'virtual:x',
  ])('finds no package in %s', (id) => {
    expect(packageOfModule(id)).toBeUndefined();
  });
});

describe('bundledPackages', () => {
  it('lists each package once, by the modules that end up in the output', () => {
    const rendered = (renderedLength: number) => ({ renderedLength });
    const bundle = {
      'a.cjs': {
        type: 'chunk' as const,
        modules: {
          '/p/node_modules/react/index.js': rendered(10),
          '/p/node_modules/react/cjs/react.js': rendered(5),
          '/p/node_modules/shaken/index.js': rendered(0),
          '/p/src/own.ts': rendered(7),
        },
      },
      'a.css': { type: 'asset' as const },
    };
    expect(bundledPackages(bundle)).toEqual(['/p/node_modules/react']);
  });
});

describe('recordBundle', () => {
  it('writes the packages under the output’s entry name', async () => {
    const { notices } = await project();
    recordBundle(notices, {
      'main.cjs': {
        type: 'chunk',
        name: 'main',
        isEntry: true,
        modules: { '/p/node_modules/zod/index.js': { renderedLength: 3 } },
      },
    });
    expect(JSON.parse(await readFile(path.join(notices, 'main.json'), 'utf8'))).toEqual([
      '/p/node_modules/zod',
    ]);
  });
});

describe('joinNotices', () => {
  it('names each bundled package with its version, license and license text, sorted', async () => {
    const { folder, notices } = await project();
    const react = await install(
      folder,
      'react',
      { license: 'MIT' },
      { LICENSE: 'MIT License\nReact text' },
    );
    const xterm = await install(
      folder,
      '@xterm/xterm',
      { license: 'MIT' },
      { 'LICENSE.md': 'Xterm text' },
    );
    await bundles(notices, [xterm, react]);
    const text = await joinNotices(notices);
    expect(text.indexOf('react 1.2.3')).toBeGreaterThan(text.indexOf('@xterm/xterm 1.2.3'));
    expect(text).toContain('License: MIT');
    expect(text).toContain('React text');
    expect(text).toContain('Xterm text');
    expect(text.match(/^react 1\.2\.3$/gm)).toHaveLength(1);
  });

  it.each(['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'COPYING', 'LICENCE'])(
    'finds a license in a file named %s',
    async (file) => {
      const { folder, notices } = await project();
      const named = await install(folder, 'named', { license: 'MIT' }, { [file]: 'Named text' });
      await bundles(notices, [named]);
      await expect(joinNotices(notices)).resolves.toContain('Named text');
    },
  );

  it('does not take a file that only starts like a license for one', async () => {
    const { folder, notices } = await project();
    const odd = await install(folder, 'odd', { license: 'MIT' }, { 'LICENSE_CHECK.js': 'x' });
    await bundles(notices, [odd]);
    await expect(joinNotices(notices)).rejects.toThrow(/no license file/);
  });

  it('includes an Apache package’s NOTICE', async () => {
    const { folder, notices } = await project();
    const mcp = await install(
      folder,
      'wired',
      { license: 'Apache-2.0' },
      { LICENSE: 'Apache text', NOTICE: 'Wired notice' },
    );
    await bundles(notices, [mcp]);
    expect(await joinNotices(notices)).toContain('Wired notice');
  });

  it('lists the Agent SDK with a pointer to its own license, whatever that license says', async () => {
    const { folder, notices } = await project();
    const sdk = await install(
      folder,
      '@anthropic-ai/claude-agent-sdk',
      { license: 'SEE LICENSE IN README.md' },
      {},
    );
    await bundles(notices, [sdk]);
    const text = await joinNotices(notices);
    expect(text).toContain('@anthropic-ai/claude-agent-sdk 1.2.3');
    expect(text).toContain('claude-agent-sdk-LICENSE.md');
  });

  it('refuses a bundled package with no license file, naming it', async () => {
    const { folder, notices } = await project();
    const bare = await install(folder, 'bare', { license: 'MIT' }, {});
    await bundles(notices, [bare]);
    await expect(joinNotices(notices)).rejects.toThrow(/bare 1\.2\.3.*no license file/);
  });

  it.each([
    ['GPL-3.0-only', 'GPL-3.0-only'],
    ['an AND with one disallowed side', '(MIT AND GPL-3.0-only)'],
    ['a grouped OR joined by AND to a disallowed one', '(MIT OR Apache-2.0) AND GPL-3.0-only'],
    ['an unbalanced group', '(MIT OR ISC'],
    ['no license field', undefined],
    ['an unknown license', 'SEE LICENSE IN LICENSE'],
  ])('refuses %s, naming the package and its license', async (_name, license) => {
    const { folder, notices } = await project();
    const odd = await install(folder, 'odd', license === undefined ? {} : { license }, {
      LICENSE: 'text',
    });
    await bundles(notices, [odd]);
    await expect(joinNotices(notices)).rejects.toThrow(/odd 1\.2\.3.*license/);
  });

  it.each([
    '(MIT OR GPL-3.0-only)',
    '(MIT AND ISC)',
    '(MIT OR Apache-2.0) AND ISC',
    'MIT AND GPL-3.0-only OR ISC',
    'BSD-3-Clause',
    'BlueOak-1.0.0',
    '0BSD',
  ])('accepts %s', async (license) => {
    const { folder, notices } = await project();
    const fine = await install(folder, 'fine', { license }, { LICENSE: 'text' });
    await bundles(notices, [fine]);
    await expect(joinNotices(notices)).resolves.toContain('fine 1.2.3');
  });

  it('reports every problem together, not only the first', async () => {
    const { folder, notices } = await project();
    const a = await install(folder, 'first', { license: 'MIT' }, {});
    const b = await install(folder, 'second', { license: 'GPL-3.0-only' }, { LICENSE: 'text' });
    await bundles(notices, [a, b]);
    const message = await joinNotices(notices).catch((error: unknown) => (error as Error).message);
    expect(message).toContain('first 1.2.3');
    expect(message).toContain('second 1.2.3');
  });

  describe('an addon built from its scope sibling’s repository', () => {
    const repository = 'git+https://github.com/xtermjs/xterm.js.git';
    async function xterm(folder: string, addon: Record<string, unknown>) {
      const root = path.join(folder, 'node_modules/@xterm');
      await mkdir(path.join(root, 'xterm'), { recursive: true });
      await mkdir(path.join(root, 'addon-fit'), { recursive: true });
      await writeFile(
        path.join(root, 'xterm/package.json'),
        JSON.stringify({ name: '@xterm/xterm', version: '6', license: 'MIT', repository }),
      );
      await writeFile(path.join(root, 'xterm/LICENSE'), 'The xterm.js license');
      await writeFile(
        path.join(root, 'addon-fit/package.json'),
        JSON.stringify({ name: '@xterm/addon-fit', version: '0.1', ...addon }),
      );
      return path.join(root, 'addon-fit/index.js');
    }

    it('takes the repository’s license, and says so', async () => {
      const { folder, notices } = await project();
      await bundles(notices, [await xterm(folder, { license: 'MIT', repository })]);
      const text = await joinNotices(notices);
      expect(text).toContain('@xterm/addon-fit 0.1');
      expect(text).toContain('The xterm.js license');
      expect(text).toContain('xterm repository');
    });

    it.each([
      ['another repository', { license: 'MIT', repository: 'https://github.com/other/other' }],
      ['another license', { license: 'ISC', repository }],
    ])('refuses one with %s', async (_name, addon) => {
      const { folder, notices } = await project();
      await bundles(notices, [await xterm(folder, addon)]);
      await expect(joinNotices(notices)).rejects.toThrow(/addon-fit.*no license file/);
    });
  });

  it('reads a license given as an object or a list', async () => {
    const { folder, notices } = await project();
    const old = await install(folder, 'old', { licenses: [{ type: 'MIT' }] }, { LICENSE: 'text' });
    await bundles(notices, [old]);
    await expect(joinNotices(notices)).resolves.toContain('License: MIT');
  });

  it('refuses a build missing one of its bundles’ lists', async () => {
    const { folder, notices } = await project();
    const react = await install(folder, 'react', { license: 'MIT' }, { LICENSE: 'text' });
    await bundles(notices, [react], BUNDLES.slice(1));
    await expect(joinNotices(notices)).rejects.toThrow(new RegExp(BUNDLES[0]));
  });

  it('keeps the allowlist to the licenses the design names', () => {
    expect([...ALLOWED_LICENSES].sort()).toEqual(
      [
        '0BSD',
        'Apache-2.0',
        'BSD-2-Clause',
        'BSD-3-Clause',
        'BlueOak-1.0.0',
        'CC0-1.0',
        'ISC',
        'MIT',
        'Unlicense',
      ].sort(),
    );
  });
});
