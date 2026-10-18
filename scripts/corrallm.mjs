// `pnpm corrallm`: runs the CLI bundle (dist-cli/corrallm.cjs), which `pnpm build:cli` builds.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../dist-cli/corrallm.cjs', import.meta.url));
if (!existsSync(bundle)) {
  console.error('The corrallm CLI is not built: run `pnpm build:cli` first.');
  process.exit(1);
}
createRequire(import.meta.url)(bundle);
