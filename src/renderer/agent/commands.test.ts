import { describe, expect, it } from 'vitest';

import type { SessionFeatures } from '../../shared/features';
import type { SlashCommand } from '../../shared/session';
import { catalog } from '../catalog';
import {
  completedCommands,
  continuationOf,
  offerWords,
  panelOpens,
  panelWords,
  routeText,
} from './commands';

const command = (name: string, description = ''): SlashCommand => ({
  name,
  description,
  argumentHint: '',
});

/** What a session of the shipped structured connection offers. */
const OFFERED = ['clear', 'compact', 'config', 'context', 'model', 'usage'].map((name) =>
  command(name),
);

/** A shipped connection that continues in another: the control for the made-up catalogs' tests. */
const CONNECTION =
  catalog()
    .adapters.flatMap(({ connections }) => connections)
    .find((one) => one.continueIn)?.id ?? '';

const FEATURES: SessionFeatures = {
  role: 'append',
  resume: true,
  list: true,
  live: { effort: false, stopTask: false },
  panels: {
    resume: true,
    mcp: { changes: ['reconnect'] },
    rewind: { restores: ['conversation'] },
  },
};

describe('routeText', () => {
  it('continues the commands only the declared target runs, which the session lacks', () => {
    expect(routeText('/permissions', CONNECTION, OFFERED).kind).toBe('continue');
    expect(routeText('  /login ', CONNECTION, OFFERED).kind).toBe('continue');
    expect(routeText('/export notes.md', CONNECTION, OFFERED).kind).toBe('continue');
    // Not what the session runs itself, nor a message, a path or a command it does not know.
    expect(routeText('/compact', CONNECTION, OFFERED).kind).toBe('command');
    expect(routeText('please run /permissions', CONNECTION, OFFERED).kind).toBe('send');
    expect(routeText('/src/permissions', CONNECTION, OFFERED).kind).toBe('send');
    expect(routeText('/frobnicate', CONNECTION, OFFERED).kind).toBe('send');
  });

  it('takes a bare-only command bare for the target, and with arguments for the session', () => {
    expect(routeText('/config', CONNECTION, OFFERED).kind).toBe('continue');
    expect(routeText('/config theme dark', CONNECTION, OFFERED).kind).toBe('command');
    expect(routeText('/config\n  theme dark', CONNECTION, OFFERED).kind).toBe('command');
  });

  it('leaves a command to the session once it offers it', () => {
    expect(routeText('/hooks', CONNECTION, [...OFFERED, command('hooks')]).kind).toBe('command');
  });

  it('continues a shell command by the target’s own prefix, and a prefix alone is text', () => {
    const prefix = catalog()
      .adapters.flatMap(({ connections }) => connections)
      .find(({ id }) => id === continuationOf(CONNECTION)?.id)?.shellPrefix;
    if (prefix === undefined) throw new Error('The target takes shell text.');
    expect(routeText(` ${prefix}ls -la `, CONNECTION, OFFERED).kind).toBe('shell');
    expect(routeText(prefix, CONNECTION, OFFERED).kind).toBe('send');
    expect(routeText(`Run ${prefix}ls`, CONNECTION, OFFERED).kind).toBe('send');
  });

  it('answers a declared panel’s command, and sends anything for no known connection', () => {
    expect(routeText('/resume', CONNECTION, OFFERED)).toEqual({ kind: 'panel', panel: 'resume' });
    expect(routeText('/resume', undefined, OFFERED).kind).toBe('send');
  });
});

describe('panelOpens', () => {
  it('opens a declared panel only where the session’s features say it can', () => {
    expect(panelOpens('resume', FEATURES)).toBe(true);
    expect(panelOpens('mcp', FEATURES)).toBe(true);
    expect(panelOpens('rewind', FEATURES)).toBe(true);
    expect(panelOpens('mcp', { ...FEATURES, panels: {} })).toBe(false);
    expect(panelOpens('resume', { ...FEATURES, panels: { mcp: { changes: [] } } })).toBe(false);
    // A read-only list is still a panel.
    expect(panelOpens('mcp', { ...FEATURES, panels: { mcp: { changes: [] } } })).toBe(true);
    for (const panel of ['resume', 'mcp', 'rewind'] as const) {
      expect(panelOpens(panel, null)).toBe(false);
      expect(panelOpens(panel, undefined)).toBe(false);
    }
  });

  it('says why a panel can’t open, and that nothing was sent', () => {
    expect(panelWords('mcp', null, 'Free')).toMatch(/^\/mcp can’t open yet.*Nothing was sent/);
    expect(panelWords('rewind', { ...FEATURES, panels: {} }, 'Free')).toBe(
      '/rewind isn’t available now: Free can’t restore to an earlier point in this session. Nothing was sent.',
    );
  });
});

describe('offerWords', () => {
  it('names the target, and a shell command by its prefix', () => {
    const target = { label: 'Zed Shell', shellPrefix: '$' };
    expect(
      offerWords(
        ' /settings ',
        { kind: 'continue', connection: 'x', command: command('settings') },
        target,
      ),
    ).toBe(
      '/settings runs only in Zed Shell: continue this conversation in Zed Shell to run it there.',
    );
    expect(offerWords('$ ls', { kind: 'shell', connection: 'x', command: 'ls' }, target)).toMatch(
      /^\$ ls is a shell command: Zed Shell runs text starting with "\$" as one/,
    );
  });
});

describe('completedCommands', () => {
  it('completes the session’s commands, the panels that can open, then the target’s, saying where', () => {
    const all = completedCommands(OFFERED, CONNECTION, {
      ...FEATURES,
      panels: { resume: true, mcp: { changes: [] } },
    });
    expect(all.slice(0, OFFERED.length)).toEqual(OFFERED);
    // The view’s own, right after the session’s: those that can open now.
    expect(all.slice(OFFERED.length, OFFERED.length + 2)).toEqual([
      command('resume', 'Resume a previous conversation'),
      command('mcp', 'Manage MCP servers'),
    ]);
    expect(all.some(({ name }) => name === 'rewind')).toBe(false);
    const permissions = all.find((c) => c.name === 'permissions');
    expect(permissions?.description).toMatch(/^In Terminal · /);
    // The session’s own /config is offered, not another.
    expect(all.filter((c) => c.name === 'config')).toEqual([command('config')]);
  });

  it('offers no panel while no generation is ready, and no connection’s commands for none', () => {
    expect(completedCommands(OFFERED, CONNECTION, null).map(({ name }) => name)).not.toContain(
      'mcp',
    );
    expect(completedCommands(OFFERED, undefined, FEATURES)).toEqual(OFFERED);
  });
});
