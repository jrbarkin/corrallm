import type { Implementations, OpServices } from '.';

/**
 * The app's settings (Core Server §4 A), and whether corrallm's MCP server listens on the port they
 * keep (B11 Design §16.6): a status, read quietly, never a dialog.
 */
export function settingsOps({
  defaultAdapter,
  settings,
  api,
}: OpServices): Pick<Implementations, 'settings.get'> {
  return {
    'settings.get': async () => {
      const { consents } = await settings.get();
      const status = api();
      // Stopped (or not yet started), it keeps the port it will listen on, if it keeps one.
      const port = status.port ?? (await settings.apiPort()) ?? null;
      return { defaultAdapter, consents, api: { ...status, port } as typeof status };
    },
  };
}
