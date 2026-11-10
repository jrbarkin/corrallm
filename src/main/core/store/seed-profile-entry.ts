import { readFileSync } from 'node:fs';

import { keepCanvases } from './test-store';

/*
 * For the packaged headless check (scripts/lib/headless-smoke.sh): keeps one canvas in a
 * throwaway profile, as the app would once the canvas was opened and saved and its folder picked
 * there, so that the shipped command's `serve` and `token` accept it. Built into
 * dist-check/seed-profile.cjs (vite.seed.config.mts), run by the shipped Node, and never packed.
 * Only this seeding writes the profile directly, as unit tests do; no command line mints a
 * trusted path.
 *
 * Usage: node seed-profile.cjs <profile> <canvas file> <project folder>
 */

const [profile, file, project] = process.argv.slice(2);
if (profile === undefined || file === undefined || project === undefined) {
  process.stderr.write('Usage: seed-profile <profile> <canvas file> <project folder>\n');
  process.exit(64);
}
const { id } = JSON.parse(readFileSync(file, 'utf8')) as { id: string };
void keepCanvases(profile, { [id]: { file, project } }).then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(
      `seed-profile: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
