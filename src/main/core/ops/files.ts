import type { CanvasId } from '../../../shared/canvas';
import { newCanvasId } from '../../../shared/canvas';
import type { ArgsOf } from '../../../shared/api/registry';
import type { Party } from '../../../shared/api/surface';
import type { NeedId } from '../../../shared/api/ids';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { andList } from '../../../shared/model/words';
import { OpFailure } from '../call';
import type { OpContext, RuleOutcome } from '../call';
import { partyIdOf } from '../caller';
import type { TokenCaller } from '../caller';
import type { Lifecycle } from '../canvas/lifecycle';
import type { Lost, Proposals } from '../canvas/proposals';
import { filledTemplate } from '../canvas/template';
import type { TemplateChoice } from '../canvas/template';
import type { WindowId } from '../host';
import { nameOf, partyText } from '../parties';
import { windowOf } from './window';
import type { Implementations, OpServices } from '.';

/*
 * A canvas's lifetime and where it is kept, as operations (Core Server §4 B, B9 Design §1, §5, §6,
 * §8): canvas.create, canvas.open, canvas.save, canvas.saveAs, canvas.close and project.choose,
 * over the core's Lifecycle (canvas/lifecycle.ts). canvas.open, canvas.saveAs and project.choose
 * are yours alone (D1, trust-gate): a path comes only from a dialog you complete, on the window you
 * called from. canvas.create and canvas.open called by you show the canvas in your window, in the
 * same op. A canvas a token makes is its party's (document.created_by), which its reach reads: it
 * has no folder until you pick one in the app, so nothing runs on it, but it is open and editable.
 * Its template's text the token's values filled in is marked as the token's (R34's `by`), and its
 * agents are checked as any token's new agents are (R11), at commit.
 *
 * R4's argument half (`discardChecks`): a token's canvas.close that would discard edits not saved,
 * or close a canvas a window shows, and its canvas.create replacing such a canvas, come to you as a
 * proposal, as does its canvas.save that would remove agents the file on disk has; each proposal
 * touches the canvas's document (and the file, for a save), so Allow applies it only if neither
 * changed since. A token's discard of what has no edits discards nothing.
 */

/** What each kind of proposal touches, beyond a document's entities: by key, as Lifecycle says. */
const DOCUMENT = (canvas: CanvasId) => `document:${canvas}`;
const FILE = (canvas: CanvasId) => `file:${canvas}`;

type FileOps =
  | 'canvas.create'
  | 'canvas.open'
  | 'canvas.save'
  | 'canvas.saveAs'
  | 'canvas.close'
  | 'project.choose';

export function filesOps({
  lifecycle,
  documents,
  catalog,
  defaultAdapter,
}: Pick<OpServices, 'lifecycle' | 'documents' | 'catalog' | 'defaultAdapter'>): Pick<
  Implementations,
  FileOps
> {
  return {
    'canvas.create': async (args, ctx) => {
      const { template, values, agents, connections, replace } = args;
      if (template === undefined && (values ?? agents ?? connections) !== undefined) {
        throw new OpFailure('invalid', 'values, agents and connections come with a template.');
      }
      if (replace !== undefined) lifecycle.kept(replace.canvas as string as CanvasId);
      const canvas = newCanvasId();
      // Built before anything is made: a template there isn't makes nothing.
      const document =
        template === undefined
          ? undefined
          : templateDocument(
              canvas,
              { template, ...defined({ values, agents, connections }) },
              ctx.by,
              { catalog, defaultAdapter },
            );
      documents.create(canvas, ctx.by);
      try {
        if (document !== undefined) {
          // A change like any other: a token's new agents checked as R11 checks them.
          await ctx.commit(canvas, () => ({ next: document, result: undefined }));
        } else if (ctx.caller.kind !== 'human') {
          // Its creator kept now, though it holds nothing: what the token's reach reads.
          await documents.keep(canvas);
        }
      } catch (error) {
        await documents.drop(canvas);
        throw error;
      }
      await lifecycle.made(canvas, windowIn(ctx));
      if (replace !== undefined) {
        await lifecycle.close(replace.canvas as string as CanvasId, {
          discard: replace.discard === true && ctx.caller.kind === 'human',
          by: ctx.by,
        });
      }
      return { canvas };
    },
    'canvas.open': async ({ replace }, ctx) => {
      if (replace !== undefined) lifecycle.kept(replace.canvas as string as CanvasId);
      const canvas = await lifecycle.open(windowOf(ctx));
      if (canvas !== null && replace !== undefined && (replace.canvas as string) !== canvas) {
        await lifecycle.close(replace.canvas as string as CanvasId, {
          discard: replace.discard === true,
          by: ctx.by,
        });
      }
      return { canvas };
    },
    'canvas.save': async (args) => {
      const canvas = canvasOf(args.canvas);
      lifecycle.kept(canvas);
      return { name: await lifecycle.save(canvas) };
    },
    'canvas.saveAs': async (args, ctx) => {
      const canvas = canvasOf(args.canvas);
      lifecycle.kept(canvas);
      return { name: await lifecycle.saveAs(windowOf(ctx), canvas) };
    },
    'canvas.close': async (args, ctx) => {
      const canvas = canvasOf(args.canvas);
      lifecycle.kept(canvas);
      // A token's discard of edits not saved came to you as a proposal: it discards nothing.
      await lifecycle.close(canvas, {
        discard: args.discard === true && ctx.caller.kind === 'human',
        by: ctx.by,
      });
      return {};
    },
    'project.choose': async (args, ctx) => {
      const canvas = canvasOf(args.canvas);
      lifecycle.kept(canvas);
      return { project: await lifecycle.chooseProject(windowOf(ctx), canvas) };
    },
  };
}

/** What R4's argument half reads and raises, and what a token's new canvas is checked against. */
export interface DiscardDeps {
  lifecycle: Pick<
    Lifecycle,
    'keeps' | 'shown' | 'edited' | 'nameOf' | 'lostOnSave' | 'touched' | 'keepRows'
  >;
  proposals: Pick<Proposals, 'raise'>;
  catalog: OpServices['catalog'];
  defaultAdapter: OpServices['defaultAdapter'];
  /**
   * Why the change rules would refuse `by`'s new canvas holding `document`, made as `op` by
   * `caller`, if they would: its commit's check, made ahead (refusals win over a proposal).
   */
  refusal: (
    document: CanvasDocument,
    call: { op: string; by: PartyId; caller: TokenCaller; party: Party },
  ) => string | undefined;
}

/** R4's checks on a token's arguments: each op carrying `discard`. */
export function discardChecks({
  lifecycle,
  proposals,
  catalog,
  defaultAdapter,
  refusal,
}: DiscardDeps) {
  /** Why a token may not close `canvas` itself: a window shows it, or it would discard edits. */
  async function closing(canvas: CanvasId, discard: boolean | undefined) {
    if (!lifecycle.keeps(canvas)) return undefined;
    const shown = lifecycle.shown(canvas);
    const discarding = discard === true && (await lifecycle.edited(canvas));
    return shown || discarding ? { shown, discarding } : undefined;
  }
  /** Raises the proposal of a token's call, in what it would do and lose: its Needs item's id. */
  async function propose(
    op: string,
    canvas: CanvasId,
    args: object,
    caller: TokenCaller,
    lost: Lost,
    touched: readonly string[],
  ): Promise<NeedId> {
    await lifecycle.keepRows(canvas);
    const kept = Object.fromEntries(
      Object.entries(args).filter(([key]) => key !== 'request' && key !== 'expect'),
    );
    const revs: Record<string, number> = {};
    for (const key of touched) revs[key] = (await lifecycle.touched(key)) ?? 0;
    return proposals.raise(canvas, { op, args: kept, by: partyIdOf(caller), touched: revs, lost });
  }
  /** How a canvas is named in a proposal's words. */
  const named = async (canvas: CanvasId) => (await lifecycle.nameOf(canvas)) ?? 'an unsaved canvas';

  return {
    // Its own R4 is its change's, which removes agents (rules.ts).
    'canvas.delete': (): RuleOutcome => undefined,
    'canvas.batch': (): RuleOutcome => undefined,
    'canvas.close': async (
      { canvas: id, discard }: ArgsOf<'canvas.close'>,
      { caller }: { caller: TokenCaller; party: Party },
    ): Promise<RuleOutcome> => {
      if (id === undefined) return undefined;
      const canvas = id as string as CanvasId;
      const why = await closing(canvas, discard);
      if (why === undefined) return undefined;
      const name = await named(canvas);
      const what = `close ${name}${why.discarding ? ', discarding its edits not saved' : ''}`;
      return {
        propose: await propose(
          'canvas.close',
          canvas,
          { canvas, discard },
          caller,
          wordsOf(caller, what, why, name),
          [DOCUMENT(canvas)],
        ),
      };
    },
    'canvas.create': async (
      args: ArgsOf<'canvas.create'>,
      { caller, party }: { caller: TokenCaller; party: Party },
    ): Promise<RuleOutcome> => {
      const { replace } = args;
      if (replace === undefined) return undefined;
      const canvas = replace.canvas as string as CanvasId;
      const why = await closing(canvas, replace.discard);
      if (why === undefined) return undefined;
      // Refusals first: what the new canvas would hold is checked as its commit would check it.
      if (args.template !== undefined) {
        const by = partyIdOf(caller);
        const { template, values, agents, connections } = args;
        const document = templateDocument(
          newCanvasId(),
          { template, ...defined({ values, agents, connections }) },
          by,
          { catalog, defaultAdapter },
        );
        const refused = refusal(document, { op: 'canvas.create', by, caller, party });
        if (refused !== undefined) return { refuse: refused };
      }
      const name = await named(canvas);
      const what = `replace ${name} with a new canvas${why.discarding ? ', discarding its edits not saved' : ''}`;
      return {
        propose: await propose(
          'canvas.create',
          canvas,
          args,
          caller,
          wordsOf(caller, what, why, name),
          [DOCUMENT(canvas)],
        ),
      };
    },
    'canvas.save': async (
      { canvas: id }: ArgsOf<'canvas.save'>,
      { caller }: { caller: TokenCaller; party: Party },
    ): Promise<RuleOutcome> => {
      if (id === undefined) return undefined;
      const canvas = id as string as CanvasId;
      if (!lifecycle.keeps(canvas)) return undefined;
      const lost = await lifecycle.lostOnSave(canvas);
      if (lost?.length === 0) return undefined;
      const name = await named(canvas);
      const what =
        lost === undefined
          ? `save ${name} over its file, which isn’t a canvas corrallm reads now`
          : `save ${name}, removing ${agentsText(lost)} from its file`;
      return {
        propose: await propose(
          'canvas.save',
          canvas,
          { canvas },
          caller,
          {
            what,
            title: `${partyText([], partyIdOf(caller))} asks to ${what}`,
            detail:
              lost === undefined
                ? 'Allow writes the canvas over its file as corrallm has it: whatever the file holds now is lost.'
                : `Its file on disk has ${agentsText(lost)}, which the canvas no longer has: Allow writes the canvas over it, and ${lost.length === 1 ? 'it is' : 'they are'} gone from the file.`,
          },
          [DOCUMENT(canvas), FILE(canvas)],
        ),
      };
    },
  };
}

/** A proposal's words to close or replace a canvas, `what` it would do, and why it is yours. */
function wordsOf(
  caller: TokenCaller,
  what: string,
  { shown, discarding }: { shown: boolean; discarding: boolean },
  name: string,
): Lost {
  const reasons = [
    ...(shown ? ['a window shows it'] : []),
    ...(discarding
      ? [
          `its edits not saved are discarded: ${name === 'an unsaved canvas' ? 'never saved, it is forgotten' : 'it goes back to its file'}`,
        ]
      : []),
  ];
  return {
    what,
    title: `${partyText([], partyIdOf(caller))} asks to ${what}`,
    detail: `Only the user decides: ${andList(reasons)}.`,
  };
}

/** The agents a save would remove, named. */
function agentsText(agents: readonly CanvasNode[]): string {
  const named = agents.slice(0, 5).map((agent) => nameOf(agents, agent.id));
  const more = agents.length - named.length;
  return andList(more > 0 ? [...named, `${String(more)} more`] : named);
}

/** The canvas an op names: core.call filled it in for a caller with one. */
function canvasOf(canvas: string | undefined): CanvasId {
  if (canvas === undefined) throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
  return canvas as CanvasId;
}

/** The window of yours an op came from, if it came from one: where it shows a canvas. */
function windowIn({ caller }: OpContext): WindowId | undefined {
  return caller.kind === 'human' && caller.window !== 'host' ? caller.window : undefined;
}

/** `choice` without the fields it leaves out. */
function defined(choice: {
  [K in keyof Omit<TemplateChoice, 'template'>]?: TemplateChoice[K] | undefined;
}): Omit<TemplateChoice, 'template'> {
  return Object.fromEntries(Object.entries(choice).filter(([, value]) => value !== undefined));
}

/** Template `choice` as canvas `canvas`'s document, filled by `by` (canvas/template.ts). */
function templateDocument(
  canvas: CanvasId,
  choice: TemplateChoice,
  by: PartyId,
  context: Parameters<typeof filledTemplate>[2],
): CanvasDocument {
  return { ...filledTemplate(choice, by, context).document, id: canvas };
}
