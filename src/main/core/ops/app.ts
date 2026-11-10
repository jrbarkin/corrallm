import type { Implementations, OpServices } from '.';

/**
 * The app itself (Core Server §4 A), and the `corrallm` command's link (B30 C2): yours alone,
 * over the core's command link, which writes only its own link (command-link.ts). A change
 * publishes the settings topic, whose `command` field you alone read.
 */
export function appOps({
  app,
  command,
}: Pick<OpServices, 'app' | 'command'>): Pick<Implementations, 'app.info' | 'app.command'> {
  return {
    'app.info': () => ({ name: app.name, version: app.version }),
    'app.command': async ({ action }, ctx) => {
      const result = await (action === 'install' ? command.install() : command.remove());
      if (result.changed) ctx.published('settings');
      return result;
    },
  };
}
