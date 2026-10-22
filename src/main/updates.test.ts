import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppUpdates, CHECK_EVERY_MS, LINUX_CHECK_EVERY_MS, FETCH_TIMEOUT_MS } from './updates';
import type { UpdateDialog, UpdateEvents } from './updates';

const active: AppUpdates[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const update of active.splice(0)) update.stop();
  vi.useRealTimers();
});

function setup(options: Partial<ConstructorParameters<typeof AppUpdates>[0]> = {}) {
  let events: UpdateEvents | undefined;
  const unlisten = vi.fn();
  const updater = {
    listen: vi.fn((handlers: UpdateEvents) => {
      events = handlers;
      return unlisten;
    }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  const prompt = vi.fn<(_options: UpdateDialog) => Promise<number>>(() => Promise.resolve(1));
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response('', { status: 404 })),
  );
  const deps = {
    packaged: true,
    development: false,
    selfTest: false,
    disabled: false,
    unsigned: false,
    platform: 'darwin',
    arch: 'arm64',
    version: '1.2.3',
    signedMac: vi.fn(() => Promise.resolve(true)),
    updater,
    fetch,
    prompt,
    requestQuit: vi.fn(),
    openRelease: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
    clock: {
      later: (run: () => void, ms: number) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
    },
    ...options,
  };
  const updates = new AppUpdates(deps);
  active.push(updates);
  return {
    updates,
    deps,
    updater,
    prompt,
    fetch,
    unlisten,
    events: () => {
      if (!events) throw new Error('No updater listeners');
      return events;
    },
  };
}

function release(tag: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ tag_name: tag, prerelease: false, draft: false, ...extra });
}

describe('packaged app updates', () => {
  it.each([{ packaged: false }, { development: true }, { selfTest: true }, { disabled: true }])(
    'does nothing for %j',
    async (config) => {
      const { updates, deps, updater, fetch } = setup(config);
      await updates.start();
      await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS * 2);
      expect(updater.listen).not.toHaveBeenCalled();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(deps.signedMac).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])('skips an unsigned Mac once (explicit unsigned: %s)', async (unsigned) => {
    const signedMac = vi.fn(() => Promise.resolve(false));
    const { updates, updater, deps } = setup({ unsigned, signedMac });
    await updates.start();
    await updates.start();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/unsigned.*skip|skip.*unsigned/i),
    );
    expect(signedMac).toHaveBeenCalledTimes(unsigned ? 0 : 1);
  });

  it('checks the fixed HTTPS feed at launch and every six hours, without overlapping a check', async () => {
    const { updates, updater, events, unlisten } = setup();
    await updates.start();
    expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      url: 'https://update.electronjs.org/jrbarkin/corrallm/darwin-arm64/1.2.3',
    });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    events().settled();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updates.stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('offers a download once per version, and Restart requests an ordinary quit before installing', async () => {
    const { updates, updater, events, prompt, deps } = setup();
    prompt.mockResolvedValue(0);
    await updates.start();
    events().downloaded('1.3.0');
    events().downloaded('1.3.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      buttons: ['Restart to update', 'Later'],
      cancelId: 1,
    });
    expect(deps.requestQuit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.finishQuit()).toBe(true); // Main calls this only after RunShutdown + flush + close.
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    updates.finishQuit();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('Later leaves the staged update to Squirrel on the next normal quit, without forcing a restart', async () => {
    const { updates, updater, events, deps } = setup();
    await updates.start();
    events().downloaded('1.3.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.requestQuit).not.toHaveBeenCalled();
    expect(updates.finishQuit()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('still offers a download when GitHub’s release title is not a bare semver', async () => {
    const { updates, events, prompt } = setup();
    await updates.start();
    events().downloaded('corrallm 1.3.0 — First public release');
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('cancels a requested restart if saving fails and the user keeps corrallm open', async () => {
    const { updates, updater, events, prompt } = setup();
    prompt.mockResolvedValue(0);
    await updates.start();
    events().downloaded('1.3.0');
    await vi.advanceTimersByTimeAsync(0);
    updates.cancelRestart();
    expect(updates.finishQuit()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('logs each updater error once and never shows a failure dialog', async () => {
    const { updates, events, deps, prompt } = setup();
    await updates.start();
    events().error(new Error('No releases'));
    events().error(new Error('No releases'));
    events().error(new Error('Network unavailable'));
    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('Linux release notices', () => {
  it.each([
    ['v1.10.0', {}, true],
    ['v1.2.3', {}, false],
    ['v1.2.2', {}, false],
    ['v2.0.0-beta.1', {}, false],
    ['v2.0.0', { prerelease: true }, false],
    ['v2.0.0', { draft: true }, false],
    ['not a version', {}, false],
    ['1.2.3+new-build', {}, false],
  ])('compares %s as semver and ignores drafts and prereleases', async (tag, extra, newer) => {
    const { updates, fetch, prompt, updater } = setup({ platform: 'linux' });
    fetch.mockResolvedValueOnce(release(tag, extra));
    await updates.start();
    expect(prompt).toHaveBeenCalledTimes(newer ? 1 : 0);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/jrbarkin/corrallm/releases/latest',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        signal: expect.any(AbortSignal) as AbortSignal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'corrallm/1.2.3 (linux-arm64)',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
    );
  });

  it('checks at most daily, offers each version once, and opens only the fixed release page through link policy', async () => {
    const { updates, fetch, prompt, deps } = setup({ platform: 'linux' });
    fetch.mockImplementation(() =>
      Promise.resolve(release('v1.3.0', { html_url: 'https://evil.example/' })),
    );
    prompt.mockResolvedValue(0);
    await updates.start();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      message: 'corrallm 1.3.0 is available',
      buttons: ['Open release page', 'Later'],
    });
    expect(deps.openRelease).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/jrbarkin/corrallm/releases/tag/v1.3.0',
    );
    await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(release('v1.4.0'));
    await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('treats a private repository or no releases as nothing to show, logging other failures once', async () => {
    const { updates, fetch, prompt, deps } = setup({ platform: 'linux' });
    await updates.start(); // 404
    expect(deps.log).not.toHaveBeenCalled();
    fetch.mockRejectedValue(new Error('Offline'));
    await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS * 2);
    expect(deps.log).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('bounds even a fetch that ignores cancellation and tries again on the next day', async () => {
    const { updates, fetch, deps, prompt } = setup({ platform: 'linux' });
    fetch.mockImplementationOnce(() => new Promise(() => undefined));
    const started = updates.start();
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await started;
    expect(deps.log).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a pending check on quit and never offers its late result', async () => {
    const { updates, fetch, deps, prompt } = setup({ platform: 'linux' });
    const pending = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(pending.promise);
    const started = updates.start();
    const signal = fetch.mock.calls[0]?.[1]?.signal;
    updates.stop();
    expect(signal?.aborted).toBe(true);
    await started;
    pending.resolve(release('v1.3.0'));
    await vi.advanceTimersByTimeAsync(LINUX_CHECK_EVERY_MS);
    expect(fetch).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });
});
