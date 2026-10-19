import type { Implementations, OpServices } from '.';

/** The app's settings (Core Server §4 A). */
export function settingsOps({
  defaultAdapter,
  settings,
}: OpServices): Pick<Implementations, 'settings.get'> {
  return {
    'settings.get': async () => {
      const { consents } = await settings.get();
      return { defaultAdapter, consents };
    },
  };
}
