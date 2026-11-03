import type { AdapterDescriptor, Catalog, ConnectionDescriptor } from './adapter';

/**
 * For tests: a catalog declaring only an adapter no build has (Zed Agent), with a mode that asks
 * and one that never does (its own classification, whatever another adapter's mode of the same name
 * does), a usage backend of its own, and two consents it asks for (B22a C3), on different
 * connections. What reads the catalog it is given knows it from this alone; the catalog the
 * renderer loaded (test-catalog.json) lacks all of it.
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
          prompts: { approval: 'answerable', question: 'seen', plan: 'none', form: 'answerable' },
          signals: true,
          context: false,
          api: null,
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
          prompts: { approval: 'none', question: 'none', plan: 'none', form: 'none' },
          signals: false,
          context: false,
          api: null,
          startModes: [],
          live: { effort: false, stopTask: false },
          panels: {},
          images: null,
          usage: null,
        },
      ],
      consents: [
        {
          key: 'credits',
          title: 'Spend your Zed credits',
          description: 'Zed Agent asks before a turn spends credits from your account.',
          connections: ['zed.acp'],
        },
        {
          key: 'share',
          title: 'Share your sessions with Zed',
          description: 'Zed Agent asks before it uploads a session’s transcript.',
          connections: ['zed.acp', 'zed.free'],
        },
      ],
    },
  ],
  usageBackends: [{ id: 'zed', label: 'Zed', source: '', windows: [] }],
};

const [ZED] = MADE_UP.adapters as [AdapterDescriptor];
const [ACP, FREE] = ZED.connections as [ConnectionDescriptor, ConnectionDescriptor];

/**
 * Two unfamiliar adapters; only the second adapter's second connection handles shell text. The
 * second asks a consent by a key the first asks by too, for its own connection.
 */
export const TWO_MADE_UP: Catalog = {
  adapters: [
    ...MADE_UP.adapters,
    {
      ...ZED,
      id: 'yak',
      name: 'Yak Agent',
      accent: 1,
      words: { defaults: 'From your Yak preferences' },
      connections: [
        { ...FREE, id: 'yak.free' },
        {
          ...ACP,
          id: 'yak.terminal',
          label: 'Terminal',
          short: 'Terminal',
          view: 'terminal',
          shellPrefix: '$',
          fileMentions: true,
        },
      ],
      consents: [
        {
          key: 'credits',
          title: 'Spend your Yak credits',
          description: 'Yak Agent asks before its terminal spends credits.',
          connections: ['yak.terminal'],
        },
      ],
    },
  ],
  usageBackends: MADE_UP.usageBackends,
};
