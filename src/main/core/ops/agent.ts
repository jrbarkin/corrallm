import { z } from 'zod';

import { adapterIn, isStartMode } from '../../../shared/adapter';
import * as agents from '../../../shared/model/agent-ops';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';
import { requireAgent, withoutUndefined } from './agent-document';

export function agentOps(
  context: Pick<OpServices, 'catalog' | 'defaultAdapter'>,
): Pick<
  Implementations,
  | 'agent.setType'
  | 'agent.setConnection'
  | 'agent.setFallback'
  | 'agent.setSettings'
  | 'agent.setRole'
> {
  const connectionOf = (adapter: string, connection: string) => {
    if (!adapterIn(context.catalog, adapter)?.connections.some((one) => one.id === connection))
      throw new OpFailure(
        'invalid',
        `Connection ${connection} does not belong to adapter ${adapter}.`,
      );
  };
  return {
    'agent.setType': ({ canvas, agent, adapter, connection }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireAgent(doc, agent);
        if (!adapterIn(context.catalog, adapter))
          throw new OpFailure('invalid', `There is no adapter ${adapter}.`);
        if (connection !== undefined) connectionOf(adapter, connection);
        const built = agents.setType(doc, { agent, adapter }, context);
        return connection === undefined
          ? built
          : agents.setConnection(built.next, { agent, connection }, context);
      }),
    'agent.setConnection': ({ canvas, agent, connection }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const node = requireAgent(doc, agent);
        connectionOf(node.data.adapter ?? context.defaultAdapter, connection);
        return agents.setConnection(doc, { agent, connection }, context);
      }),
    // B11a C1: your chain, its connections resolved now, distinct from the agent's own endpoint.
    'agent.setFallback': ({ canvas, agent, fallback }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireAgent(doc, agent);
        let built;
        try {
          built = agents.setFallback(doc, { agent, fallback }, context);
        } catch (error) {
          throw new OpFailure('invalid', invalidChain(error));
        }
        return { ...built, result: { changed: built.next !== doc } };
      }),
    'agent.setSettings': ({ canvas, agent, adapter, settings }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const node = requireAgent(doc, agent);
        const current = node.data.adapter ?? context.defaultAdapter;
        const descriptor = adapterIn(context.catalog, adapter);
        const connection =
          adapter === current
            ? (node.data.connection ?? descriptor?.connections[0]?.id)
            : undefined;
        if (
          settings.mode != null &&
          descriptor &&
          !isStartMode(context.catalog, adapter, connection, settings.mode)
        )
          throw new OpFailure('invalid', 'That mode cannot start on this connection.');
        return agents.setSettings(doc, { agent, adapter, change: withoutUndefined(settings) });
      }),
    'agent.setRole': ({ canvas, agent, role }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireAgent(doc, agent);
        return agents.setRole(doc, { agent, role });
      }),
  };
}

/** Why a chain can't be kept, in one sentence: the model's own words, else the schema's first. */
function invalidChain(error: unknown): string {
  if (error instanceof z.ZodError)
    return `That fallback chain can’t be kept: ${error.issues[0]?.message ?? 'it is malformed'}.`;
  return error instanceof Error ? `${error.message}.` : 'That fallback chain can’t be kept.';
}
