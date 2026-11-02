import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PREFERENCE = [
  'src/main/core/ops/settings.ts',
  'src/main/settings.ts',
  'src/renderer/useAddEndpoint.ts',
  'src/shared/api/ops/settings.ts',
];
function production(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return production(file);
    return /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !entry.name.startsWith('test-')
      ? [file]
      : [];
  });
}
it('keeps the default-agent preference at its own read and write boundaries', () => {
  const files = production('src');
  expect(
    files.filter((file) =>
      /\b(?:DEFAULT_ADAPTER|DEFAULT_AGENT)\b/.test(readFileSync(path.join(ROOT, file), 'utf8')),
    ),
  ).toEqual([]);
  expect(
    files
      .filter((file) => /\bdefaultAdapter\b/.test(readFileSync(path.join(ROOT, file), 'utf8')))
      .sort(),
  ).toEqual(PREFERENCE);
});
