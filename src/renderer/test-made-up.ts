import type { Catalog } from '../shared/adapter';

/**
 * For tests: a catalog declaring only an adapter no build has (Zed Agent), with a mode that asks
 * and one that never does (its own classification, whatever another adapter's mode of the same name
 * does), and a usage backend of its own. What reads the catalog it is given knows it from this
 * alone; the catalog the renderer loaded (test-catalog.json) lacks all of it.
 */
export const MADE_UP: Catalog = {
  adapters: [
    {
      id: 'zed',
      name: 'Zed Agent',
      accent: 0,
      words: { defaults: '' },
      modes: [
        { id: 'plan', label: 'Plan', description: '', asks: true, rank: 0 },
        { id: 'auto', label: 'Auto', description: '', asks: false, rank: 1 },
      ],
      runtimeModes: false,
      role: 'none',
      resume: false,
      list: false,
      actions: [{ name: 'shell', description: 'Run a command', job: 'shell' }],
      connections: [
        {
          id: 'zed.acp',
          label: 'ACP',
          short: 'ACP',
          description: '',
          view: 'transcript',
          startModes: ['plan'],
          live: { effort: false, stopTask: false },
          panels: {},
          images: null,
          usage: 'zed',
        },
        {
          id: 'zed.free',
          label: 'Free',
          short: 'Free',
          description: '',
          view: 'transcript',
          startModes: [],
          live: { effort: false, stopTask: false },
          panels: {},
          images: null,
          usage: null,
        },
      ],
    },
  ],
  usageBackends: [{ id: 'zed', label: 'Zed', source: '', windows: [] }],
};
