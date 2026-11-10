import type { ResultOf } from '../../../shared/api/registry';
import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';
import { requireAgent } from './agent-document';

/*
 * Who leads, and the outside orchestrators you let answer approvals (B24 Design §3, §8, C1, C9):
 * yours alone, every one (core.call refuses every token before these run: the permissions
 * deviation), over the core's lead store (leads.ts), kept on this machine and never in a canvas
 * file. A change is on disk before the op answers, and names `leads:<c>` and `needs:<c>` for its
 * receipts: whoever leads, or may answer, there may have changed.
 */

/** What these ops read and change. */
export type LeadServices = Pick<OpServices, 'leads' | 'documents' | 'states' | 'tokens'>;

export function leadOps(
  services: LeadServices,
): Pick<Implementations, 'agent.setLead' | 'outside.setGrant' | 'leads.get'> {
  const { leads, documents } = services;
  return {
    'agent.setLead': async ({ canvas, agent, lead }, ctx) => {
      const id = keptCanvas(services, canvas);
      await documents.load(id);
      // Between the canvas's commits, so its fingerprint is of its agent as the change finds it.
      await documents.between(id, async () => {
        const live = documents.loaded(id);
        if (live === undefined) throw new OpFailure('not-found', `There is no canvas ${id}.`);
        const node = requireAgent(live.document, agent);
        if (lead === null) {
          ctx.noReturn();
          await leads.set(id, agent, null);
          return;
        }
        const fingerprint = leads.fingerprintOf(node.data);
        if (fingerprint === undefined)
          throw new OpFailure('invalid', 'Choose its agent before making it a lead.');
        ctx.noReturn();
        await leads.set(id, agent, { grants: lead.grants, fingerprint });
      });
      ctx.published(`leads:${id}`);
      ctx.published(`needs:${id}`);
      return {};
    },
    'outside.setGrant': async ({ canvas, name, approvals }, ctx) => {
      const id = keptCanvas(services, canvas);
      // Only to an orchestrator whose live write token reaches the canvas now; taking one back,
      // whatever its token's state, always.
      if (approvals && !liveWriters(services, id).has(name))
        throw new OpFailure(
          'refused',
          `No live write token named ${name} reaches this canvas: make one first.`,
        );
      ctx.noReturn();
      if (await leads.setGrant(id, name, approvals)) {
        ctx.published(`leads:${id}`);
        ctx.published(`needs:${id}`);
      }
      return {};
    },
    'leads.get': async ({ canvas }) => leadsListing(services, keptCanvas(services, canvas)),
  };
}

/**
 * Who leads on `canvas` and the outside orchestrators there, as you read them (leads.get, and the
 * `leads:<c>` topic): each lead with its grants and what holds it; and each name whose live write
 * token reaches the canvas, or that you let answer its approvals, with whether you did and whether
 * a live token has it. No hash, value or expiry of a token.
 */
export async function leadsListing(
  services: LeadServices,
  canvas: CanvasId,
): Promise<ResultOf<'leads.get'>> {
  const { leads, documents } = services;
  // Loaded, so the rows of agents gone are pruned and what changed since is held first.
  await documents.load(canvas);
  const granted = leads.granted(canvas);
  const live = liveWriters(services, canvas);
  const names = [...new Set([...granted, ...live])].sort();
  return {
    leads: leads.view(canvas),
    outside: names.map((name) => ({
      name,
      approvals: granted.includes(name),
      live: live.has(name),
    })),
  };
}

/** The names of the live write tokens that reach `canvas`: granted it, or whose party made it. */
function liveWriters({ tokens, documents }: LeadServices, canvas: CanvasId): Set<string> {
  return new Set(
    tokens
      .live()
      .filter(
        (token) =>
          token.access !== 'read' &&
          (token.canvases.includes(canvas) ||
            documents.createdBy(`outside:${token.name}`).includes(canvas)),
      )
      .map((token) => token.name),
  );
}

/** The canvas a call names, which the core must keep. */
function keptCanvas({ states }: LeadServices, canvas: string | undefined): CanvasId {
  if (canvas === undefined) throw new OpFailure('invalid', 'Name the canvas it is for.');
  const id = canvas as unknown as CanvasId;
  if (!states.keeps(id)) throw new OpFailure('not-found', `There is no canvas ${id}.`);
  return id;
}
