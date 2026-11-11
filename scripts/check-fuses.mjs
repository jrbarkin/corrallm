// Reads the fuses back from a packaged Electron binary and compares them with build/fuses.ts:
//   node scripts/check-fuses.mjs <path to the app's executable>
// Exits 1, naming each fuse that differs. Run by `check-macos.sh --release`.
import { getCurrentFuseWire } from '@electron/fuses';

import { diffFuses } from '../build/fuses.ts';

const binary = process.argv[2];
if (!binary) {
  console.error('Usage: node scripts/check-fuses.mjs <executable>');
  process.exit(2);
}
const problems = diffFuses(await getCurrentFuseWire(binary));
for (const problem of problems) console.error(`fuse differs: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`fuses match the configuration: ${binary}`);
