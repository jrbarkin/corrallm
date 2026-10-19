import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { launchApp } from './launch';

/*
 * Gate G4 of the core's database (Core Database §8), with the built app: a profile's core.db that
 * isn't a database any more is set aside as the core opens it, the newest snapshot restored in its
 * place (none: it starts empty), and the app runs on, saying so in its window.
 */

let dir: string;
let profile: string;

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-e2e-damaged-store-'));
  profile = path.join(dir, 'profile');
  await mkdir(profile);
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the app once on the profile: its database made, and a snapshot of it as it quits. */
async function runOnce(): Promise<void> {
  const { app, close } = await launchApp({ profile });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  await expect(page.getByRole('toolbar', { name: 'Canvas file' })).toBeVisible();
  await close();
}

for (const snapshot of [true, false]) {
  test(`sets a damaged database aside and runs on, ${snapshot ? 'restored from its snapshot' : 'empty'}, saying so`, async () => {
    await runOnce();
    if (!snapshot) await rm(path.join(profile, 'backups'), { recursive: true, force: true });
    await writeFile(path.join(profile, 'core.db'), 'This is not a database. '.repeat(500));

    const { app, close } = await launchApp({ profile });
    try {
      const page = await app.firstWindow();
      const said = page.getByRole('alert');
      await expect(said).toContainText(
        /The core’s database was damaged \(file is not a database\), and was moved to .+core\.rejected-[0-9a-f-]{36}\.db\./,
      );
      await expect(said).toContainText(
        snapshot
          ? /It was restored from its snapshot of .+: what changed since then is lost\./
          : 'It starts empty.',
      );
      expect(
        (await readdir(profile)).filter((name) => /^core\.rejected-.+\.db$/.test(name)),
      ).toHaveLength(1);
      // It runs on: the warning dismissed, a new canvas begins.
      await said.getByRole('button', { name: 'Dismiss' }).click();
      await expect(said).toHaveCount(0);
      const file = page.getByRole('toolbar', { name: 'Canvas file' });
      await file.getByRole('button', { name: 'New' }).click();
      await expect(file).toContainText('Untitled');
    } finally {
      await close();
    }
  });
}
