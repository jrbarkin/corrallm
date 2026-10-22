import { expect, it, vi } from 'vitest';

// Storage helpers are also loaded by Playwright's native ESM loader. They must not load
// connectors, terminal emulators or adapter assets simply to seed a profile.
vi.mock('./sessions/adapters', () => {
  throw new Error('Storage loaded the adapter runtime');
});

it('loads canvas memory and the store helpers without the adapter runtime', async () => {
  const { CanvasMemory } = await import('./memory');
  const { keepCanvases } = await import('./core/store/test-store');
  expect(CanvasMemory).toBeTypeOf('function');
  expect(keepCanvases).toBeTypeOf('function');
});
