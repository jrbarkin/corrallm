import { describe, expect, it } from 'vitest';

import { fromMain, ipcErrorMessage } from './ipc-error';

describe('a call to main that fails', () => {
  it('is worded as main worded it, without what IPC adds', () => {
    const error = new Error(
      "Error invoking remote method 'session:start': Error: Choose a project folder first.",
    );
    expect(ipcErrorMessage(error)).toBe('Choose a project folder first.');
    expect(ipcErrorMessage(new Error('Not running.'))).toBe('Not running.');
  });

  it('rejects in main’s own words, and resolves as main did', async () => {
    await expect(
      fromMain(
        Promise.reject(
          new Error("Error invoking remote method 'session:send': TypeError: No such agent"),
        ),
      ),
    ).rejects.toThrow(/^No such agent$/);
    await expect(fromMain(Promise.resolve(null))).resolves.toBeNull();
  });
});
