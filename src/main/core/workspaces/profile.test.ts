import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { PROFILE_ID } from './owned';
import { profileId } from './profile';

/*
 * The profile's id, which names its workspaces' branches and their folder in a checkout: made once,
 * kept beside its database (a restored database keeps it), never replaced by a guess.
 */

let profile: string;
beforeEach(() => {
  profile = mkdtempSync(path.join(tmpdir(), 'corrallm-profile-id-'));
});
afterEach(() => {
  rmSync(profile, { recursive: true, force: true });
});

it('is made once, privately, and read back the same', () => {
  const id = profileId(profile);
  expect(id).toMatch(PROFILE_ID);
  const file = path.join(profile, 'workspaces', 'profile-id');
  expect(readFileSync(file, 'utf8')).toBe(`${id}\n`);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(profileId(profile)).toBe(id);
});

it('refuses one it can’t read rather than making another', () => {
  mkdirSync(path.join(profile, 'workspaces'));
  writeFileSync(path.join(profile, 'workspaces', 'profile-id'), '../not-an-id\n');
  expect(() => profileId(profile)).toThrow(/profile/);
  expect(readFileSync(path.join(profile, 'workspaces', 'profile-id'), 'utf8')).toBe(
    '../not-an-id\n',
  );
});
