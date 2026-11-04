import { adapterIn, consentIn } from '../../../shared/adapter';
import type { LinksView } from '../../../shared/api/ops/settings';
import { SettingsFailure } from '../../settings';
import { canonicalOrigin } from '../../url-policy';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';

/** What you are told when the remembered sites can't be read: a fixed sentence, no value. */
const LINKS_UNREADABLE = 'corrallm couldn’t read the sites you said to open without asking.';
/** What any reader is told when the settings can't be read: never the error, which names a file. */
const SETTINGS_UNREADABLE = 'corrallm couldn’t read your settings.';

/**
 * The app's settings (Core Server §4 A), and whether corrallm's MCP server listens on the port they
 * keep (B11 Design §16.6): a status, read quietly, never a dialog. The default agent (B12 C2) is
 * the one you saved, or null, never a registry's: `settings.set`, yours alone (D8, the consent
 * deviation), writes it first and then publishes it, and a write that fails changes nothing.
 * Setting it checks or implies no installation, login or consent.
 *
 * B22a: you alone read whether OS notifications are on and how the last one went (B14 C11, C9),
 * and the sites you said to open without asking, beside the product's own (`varies`); a token's
 * read is as it was, without reading the sites at all. `settings.set` takes exactly one intent:
 * the default agent, notifications on or off, or taking back one consent or one site, each strict
 * (written first, refused as unavailable with nothing changed when it can't be read or saved).
 * Taking back never grants: only your answer to the prompt a connection raises does.
 */
export function settingsOps({
  catalog,
  settings,
  api,
  links,
  notifications,
}: OpServices): Pick<Implementations, 'settings.get' | 'settings.set'> {
  return {
    'settings.get': async (_args, ctx) => {
      const status = api();
      let kept: Awaited<ReturnType<typeof settings.get>>;
      let port: number | null;
      try {
        kept = await settings.get();
        // Stopped (or not yet started), it keeps the port it will listen on, if it keeps one.
        port = status.port ?? (await settings.apiPort()) ?? null;
      } catch {
        throw new OpFailure('unavailable', SETTINGS_UNREADABLE);
      }
      const base = {
        defaultAdapter: kept.defaultAdapter,
        consents: kept.consents,
        api: { ...status, port } as typeof status,
      };
      if (ctx.party !== 'you') return base;
      let sites: LinksView;
      try {
        sites = { state: 'ready', sites: await links.sites(), builtIn: links.builtIn() };
      } catch {
        // Never read as none, nor said why: the file's path and its error stay main's.
        sites = { state: 'unavailable', sentence: LINKS_UNREADABLE };
      }
      return {
        ...base,
        notifications: {
          enabled: kept.notifications?.enabled !== false,
          lastDelivery: notifications.status() ?? null,
        },
        links: sites,
      };
    },
    'settings.set': async (args, ctx) => {
      if (args.notifications !== undefined) {
        const { enabled } = args.notifications;
        const written = await strictly(() => notifications.set(enabled), {
          read: 'corrallm couldn’t read your settings, so notifications are unchanged.',
          write: 'corrallm couldn’t save your notification setting; it is unchanged.',
        });
        if (written) ctx.published('settings');
        return { notifications: { enabled } };
      }
      if (args.consent !== undefined) {
        const target = args.consent;
        let changed: boolean;
        if (target.kind === 'adapter') {
          // Declared: a live session may hold it with nothing kept, so it is always taken back.
          // Not declared (an adapter or a key this build lacks): only a kept one is removed.
          const declared = consentIn(catalog, target.adapter, target.key) !== undefined;
          changed = await strictly(
            () => settings.resetConsent(target.adapter, target.key, declared),
            {
              read: 'corrallm couldn’t read your settings, so this consent is unchanged.',
              write: 'corrallm couldn’t save taking back this consent; it is unchanged.',
            },
          );
        } else {
          if (canonicalOrigin(target.origin) === null) {
            throw new OpFailure(
              'invalid',
              'A site is taken back by its origin alone, as Settings lists it: its scheme, host and any port.',
            );
          }
          changed = await strictly(() => links.forget(target.origin), {
            read: 'corrallm couldn’t read the sites you said to open without asking, so this one is unchanged.',
            write: 'corrallm couldn’t save taking back this site; it is unchanged.',
          });
        }
        if (changed) ctx.published('settings');
        return { consent: { target, changed } };
      }
      const defaultAdapter = args.defaultAdapter ?? null;
      if (defaultAdapter !== null && adapterIn(catalog, defaultAdapter) === undefined) {
        throw new OpFailure('invalid', `There is no adapter ${defaultAdapter} in this build.`);
      }
      const written = await strictly(() => settings.setDefaultAdapter(defaultAdapter), {
        read: 'corrallm couldn’t read your settings, so your default agent is unchanged.',
        write: 'corrallm couldn’t save your default agent; it is unchanged.',
      });
      // Its receipt: the settings topic's revision, once every window's copy has it.
      if (written) ctx.published('settings');
      return { defaultAdapter };
    },
  };
}

/**
 * `write`'s result, or its refusal as unavailable in the fixed words for the stage that failed:
 * never the error's own, which may name a file.
 */
async function strictly<T>(
  write: () => Promise<T>,
  sentences: { read: string; write: string },
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw new OpFailure(
      'unavailable',
      error instanceof SettingsFailure && error.stage === 'read' ? sentences.read : sentences.write,
    );
  }
}
