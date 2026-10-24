import type { CanvasId } from '../../shared/canvas';
import type { TokenAnswer, TokenOwner, TokenRequest } from './token-socket';
import type { TokenStore } from './tokens';

/*
 * What the owner of a profile does with a request of `corrallm token` (Build Plan B30), whether it
 * is the app's core or `corrallm serve` (over the token socket), or `corrallm token` itself, under
 * core.lock, when nothing owns the profile. `new` makes a token for the canvases its files hold,
 * each only if canvas memory keeps that very file for it with a project folder picked in the app,
 * as `serve --canvas` does (`Core.keptCanvas`), replacing any live token of its name; `renew` makes
 * a new value for the live token of a name, reaching what it reached; `revoke` removes it. Each
 * takes effect at once. The answer holds the new token's value, the one time it leaves the owner,
 * and never a log or a file of the owner's: the token store keeps only its hash.
 */

export interface TokenRequestServices {
  /** Who answers. */
  owner: TokenOwner;
  tokens: Pick<TokenStore, 'create' | 'renew' | 'revoke' | 'grant'>;
  /** The canvas a file holds, if corrallm keeps it there with its folder; else rejects, saying why. */
  keptCanvas: (file: string) => Promise<CanvasId>;
  /** The file corrallm keeps a canvas in, to name it by. */
  fileOf: (canvas: CanvasId) => Promise<string | undefined>;
  /** Where the owner's MCP server listens, or will: null when none does. */
  url: string | null;
}

/** Answers `request` for the profile `services` keep. */
export async function answerTokenRequest(
  request: TokenRequest,
  services: TokenRequestServices,
): Promise<TokenAnswer> {
  const { owner, tokens } = services;
  switch (request.op) {
    case 'new': {
      const canvases: CanvasId[] = [];
      for (const file of request.canvases) {
        let canvas: CanvasId;
        try {
          canvas = await services.keptCanvas(file);
        } catch (error) {
          return { ok: false, sentence: error instanceof Error ? error.message : String(error) };
        }
        if (!canvases.includes(canvas)) canvases.push(canvas);
      }
      const token = await tokens.create({
        name: request.name,
        canvases,
        access: request.access,
        hours: request.hours,
      });
      return made('new', request.name, token, services);
    }
    case 'renew': {
      const token = await tokens.renew(request.name, request.hours);
      return token === undefined
        ? { ok: false, sentence: noLiveToken(request.name) }
        : made('renew', request.name, token, services);
    }
    case 'revoke':
      return (await tokens.revoke(request.name))
        ? { ok: true, owner, op: 'revoke', name: request.name }
        : { ok: false, sentence: noLiveToken(request.name) };
  }
}

/** A token just made or renewed, as answered. */
async function made(
  op: 'new' | 'renew',
  name: string,
  token: string,
  { owner, tokens, fileOf, url }: TokenRequestServices,
): Promise<TokenAnswer> {
  const grant = tokens.grant(name);
  if (grant === undefined) throw new Error(`The token for “${name}” is gone already.`);
  const canvases = await Promise.all(
    grant.canvases.map(async (id) => {
      const file = await fileOf(id);
      return file === undefined ? { id } : { id, file };
    }),
  );
  return {
    ok: true,
    owner,
    op,
    token,
    name,
    access: grant.access,
    expires: grant.expires,
    canvases,
    url,
  };
}

function noLiveToken(name: string): string {
  return `No live token is named “${name}”: it was never made, has expired, or was revoked. Make one with corrallm token new --canvas <file> --name ${name}.`;
}
