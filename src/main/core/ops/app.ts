import type { Implementations, OpServices } from '.';

/** The app itself (Core Server §4 A). */
export function appOps({ app }: Pick<OpServices, 'app'>): Pick<Implementations, 'app.info'> {
  return {
    'app.info': () => ({ name: app.name, version: app.version }),
  };
}
