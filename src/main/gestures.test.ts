import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUI_OPS, SURFACE } from '../shared/api/surface';
import { NO_GESTURE } from '../renderer/api/gestures';
import { missingGestures } from './test-gestures';

const ROOT = path.resolve(import.meta.dirname, '../renderer');
function sources(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sources(path.join(dir, entry.name));
    return /\.tsx?$/.test(entry.name) && !/\.test\.|^test-/.test(entry.name)
      ? [readFileSync(path.join(dir, entry.name), 'utf8')]
      : [];
  });
}

describe('T6: GUI operations have gestures', () => {
  it('finds a renderer call site or an explicit reason for every GUI operation without reads', () => {
    expect(missingGestures(GUI_OPS, SURFACE, sources(), NO_GESTURE)).toEqual([]);
  });

  it('rejects an unreachable operation, ignoring tests, comments and a function mentioned as text', () => {
    const surface = {
      'app.info': SURFACE['app.info'],
      'usage.get': SURFACE['usage.get'],
      'link.open': SURFACE['link.open'],
    };
    expect(
      missingGestures(
        Object.keys(surface),
        surface,
        [
          `import { api } from './api/client'; api.appInfo(); // api.linkOpen({});\nconst name = 'api.linkOpen({})';`,
        ],
        {},
      ),
    ).toEqual(['link.open']);
    expect(
      missingGestures(Object.keys(surface), surface, [], { 'link.open': 'A later gesture.' }),
    ).toEqual(['app.info']);
  });
});
