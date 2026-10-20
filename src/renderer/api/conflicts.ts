import { ApiError } from './bridge';

/** Rebuild from the refreshed mirror once; repeated conflicts are shown to the caller. */
export async function refreshOnConflict<T>(
  attempt: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'conflict') throw error;
    await refresh();
    return attempt();
  }
}
