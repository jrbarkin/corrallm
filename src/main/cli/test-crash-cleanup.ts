import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { ChildSystem } from '../core/children';
import type { TestChildren } from './test-children';
import { recordedTestGroups, stopTestGroups } from './test-process-groups';

/** Crash-test teardown must finish the parent and its recorded CLI groups before removal. */
export async function cleanupCrash(
  directory: string,
  profile: string,
  children: Pick<TestChildren, 'close'>,
  system?: ChildSystem,
): Promise<void> {
  // No more CLI can be spawned or recorded after the owner's exit and pipe closure.
  await children.close();
  const file = path.join(profile, 'sessions', 'pids.json');
  await stopTestGroups(await recordedTestGroups(file), system);
  await rm(directory, { recursive: true, force: true });
}
