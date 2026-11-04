import { connectionIn } from '../../shared/adapter';
import type { ConnectionDescriptor, ConnectionId } from '../../shared/adapter';
import type { SessionFeatures } from '../../shared/features';
import { PANELS, routeOf } from '../../shared/routing';
import type { Panel, Route } from '../../shared/routing';
import type { SlashCommand } from '../../shared/session';
import { catalog } from '../catalog';

/*
 * The slash commands an agent's composer knows besides its session's own, and where a message
 * goes (src/shared/routing.ts: the one decision the core's `message` admission shares). Some
 * commands the view answers itself, in a panel its connection declares (VIEW_COMMANDS: /resume's
 * picker, /mcp's servers, /rewind); the others a connection's descriptor says only its
 * `continueIn` connection runs, and a shell command is text that connection's own `shellPrefix`
 * starts. Those are offered to continue there, never sent. Nothing here names a CLI: what is
 * particular to one is in its adapter's descriptor.
 */

/** The commands the agent view answers itself, each a panel a connection may declare. */
export const VIEW_COMMANDS = [
  { name: 'resume', description: 'Resume a previous conversation', argumentHint: '' },
  { name: 'mcp', description: 'Manage MCP servers', argumentHint: '' },
  {
    name: 'rewind',
    description: 'Restore the code and/or conversation to a previous point',
    argumentHint: '',
  },
] as const satisfies readonly (SlashCommand & { name: Panel })[];

export type ViewCommand = (typeof VIEW_COMMANDS)[number]['name'];

/** The connection an agent's connection continues in, if it declares one this build has. */
export function continuationOf(
  connection: ConnectionId | undefined,
): ConnectionDescriptor | undefined {
  const continueIn = connectionIn(catalog(), connection)?.connection.continueIn;
  return continueIn && connectionIn(catalog(), continueIn.connection)?.connection;
}

/** Where `text` goes for an agent on `connection` whose session offers `offered`. */
export function routeText(
  text: string,
  connection: ConnectionId | undefined,
  offered: readonly SlashCommand[] | undefined,
): Route {
  const found = connectionIn(catalog(), connection)?.connection;
  if (found === undefined) return { kind: 'send' };
  return routeOf(text, { connection: found, target: continuationOf(connection), offered });
}

/** Whether the panel of `panel` can open now in a session whose usable features are `features`. */
export function panelOpens(panel: Panel, features: SessionFeatures | null | undefined): boolean {
  if (!features) return false;
  switch (panel) {
    case 'resume':
      return features.panels.resume === true;
    case 'mcp':
      return features.panels.mcp !== undefined;
    case 'rewind':
      return (features.panels.rewind?.restores.length ?? 0) > 0;
  }
}

/** What a declared panel says when it can't open now, and that nothing was sent. */
export function panelWords(
  panel: Panel,
  features: SessionFeatures | null | undefined,
  connection: string,
  reported = false,
): string {
  const command = `/${panel}`;
  if (!features && reported) {
    return `${command} isn’t available: this agent’s session is running but didn’t say what it supports, so none of its conversation features are offered. Nothing was sent.`;
  }
  if (!features) {
    return `${command} can’t open yet: this agent’s session isn’t ready. Nothing was sent; try it once the session has started.`;
  }
  const why: Readonly<Record<Panel, string>> = {
    resume: `${connection} can’t list this folder’s conversations to resume in this session`,
    mcp: `${connection} can’t list its MCP servers in this session`,
    rewind: `${connection} can’t restore to an earlier point in this session`,
  };
  return `${command} isn’t available now: ${why[panel]}. Nothing was sent.`;
}

/** What an offer to continue in `target` says about the text that starts it. */
export function offerWords(
  text: string,
  route: Extract<Route, { kind: 'continue' | 'shell' }>,
  target: Pick<ConnectionDescriptor, 'label' | 'shellPrefix'>,
): string {
  const shown = text.trim();
  return route.kind === 'continue'
    ? `${shown} runs only in ${target.label}: continue this conversation in ${target.label} to run it there.`
    : `${shown} is a shell command: ${target.label} runs text starting with "${target.shellPrefix ?? ''}" as one, without asking. Continue this conversation in ${target.label} to run it there.`;
}

/**
 * Completes the session's commands, the panels of its connection that can open now, and the
 * commands only its `continueIn` connection runs (saying where), unless the session offers one of
 * that name. A name its connection declares as a panel is the panel's, whatever the session offers.
 */
export function completedCommands(
  offered: readonly SlashCommand[] | undefined,
  connection: ConnectionId | undefined,
  features: SessionFeatures | null | undefined,
): SlashCommand[] {
  const found = connectionIn(catalog(), connection)?.connection;
  const declared = new Set<string>(
    PANELS.filter((panel) => found !== undefined && Object.hasOwn(found.panels, panel)),
  );
  const shown = VIEW_COMMANDS.filter((c) => declared.has(c.name) && panelOpens(c.name, features));
  const own = (offered ?? []).filter((c) => !declared.has(c.name));
  const names = new Set(own.map((c) => c.name));
  const target = continuationOf(connection);
  const continued = target ? (found?.continueIn?.commands ?? []) : [];
  return [
    ...own,
    ...shown,
    ...continued
      .filter((c) => !names.has(c.name))
      .map(({ name, description, argumentHint }) => ({
        name,
        description: `In ${target?.label ?? ''} · ${description}`,
        argumentHint,
      })),
  ];
}
