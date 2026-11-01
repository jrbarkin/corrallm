import { adapterIn } from '../../../shared/adapter';
import { SettingsFailure } from '../../settings';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';

/**
 * The app's settings (Core Server §4 A), and whether corrallm's MCP server listens on the port they
 * keep (B11 Design §16.6): a status, read quietly, never a dialog. The default agent (B12 C2) is
 * the one you saved, or null, never a registry's: `settings.set`, yours alone (D8, the consent
 * deviation), writes it first and then publishes it, and a write that fails changes nothing.
 * Setting it checks or implies no installation, login or consent.
 */
export function settingsOps({
  catalog,
  settings,
  api,
}: OpServices): Pick<Implementations, 'settings.get' | 'settings.set'> {
  return {
    'settings.get': async () => {
      const { consents, defaultAdapter } = await settings.get();
      const status = api();
      // Stopped (or not yet started), it keeps the port it will listen on, if it keeps one.
      const port = status.port ?? (await settings.apiPort()) ?? null;
      return { defaultAdapter, consents, api: { ...status, port } as typeof status };
    },
    'settings.set': async ({ defaultAdapter }, ctx) => {
      if (defaultAdapter !== null && adapterIn(catalog, defaultAdapter) === undefined) {
        throw new OpFailure('invalid', `There is no adapter ${defaultAdapter} in this build.`);
      }
      let written: boolean;
      try {
        written = await settings.setDefaultAdapter(defaultAdapter);
      } catch (error) {
        if (error instanceof SettingsFailure && error.stage === 'read') {
          throw new OpFailure(
            'unavailable',
            'corrallm couldn’t read your settings, so your default agent is unchanged.',
          );
        }
        throw new OpFailure(
          'unavailable',
          'corrallm couldn’t save your default agent; it is unchanged.',
        );
      }
      // Its receipt: the settings topic's revision, once every window's copy has it.
      if (written) ctx.published('settings');
      return { defaultAdapter };
    },
  };
}
