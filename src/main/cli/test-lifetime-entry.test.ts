import { afterEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  main: true,
  register: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  watch: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock('node:worker_threads', () => ({
  get isMainThread() {
    return fakes.main;
  },
}));
vi.mock('./test-lifetime', () => ({
  registerTestCli: fakes.register,
  watchTestLifetime: fakes.watch,
}));
vi.mock('./test-children', () => ({ TestChildren: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([true, false])(
  'registers only the process main thread (isMainThread: %s)',
  async (main) => {
    vi.resetModules();
    vi.clearAllMocks();
    fakes.main = main;
    vi.stubEnv('CORRALLM_TEST_SCOPE', '/test-scope');
    await import('./test-lifetime-entry');
    expect(fakes.register).toHaveBeenCalledTimes(main ? 1 : 0);
    expect(fakes.watch).not.toHaveBeenCalled();
  },
);
