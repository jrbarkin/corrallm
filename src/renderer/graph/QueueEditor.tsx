import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import { USAGE_WINDOWS } from '../../shared/usage';
import type { AdapterId, UsageBackendId } from '../../shared/adapter';
import type { UsageWindow } from '../../shared/usage';
import { threadTitle } from '../../shared/model/session';
import { catalog as loadedCatalog } from '../catalog';
import { answersOf, usageAnswers } from '../../shared/engine/run/asks';
import type { Answers } from '../../shared/engine/run/asks';
import type { EngineCatalog } from '../../shared/engine/catalog';
import type { Answer, TaskAttempt, TaskProblem } from '../../shared/engine/run/runner';
import { SearchPicker } from '../search/SearchPicker';
import { useDraft } from '../useDraft';
import { backendOfType } from '../usage/usage';
import {
  andList,
  describe,
  expectedText,
  ifText,
  itemLabel,
  leftText,
  limitText,
  okWhat,
  otherwiseText,
  roundsText,
  timeText,
  untilText,
  waitTargetLabel,
  windowText,
} from '../../shared/model/words';
import { DEFAULT_AGENT, runCatalog } from './agents';
import type { AgentAction } from './agents';
import type { AgentNode, CanvasNode } from '../../shared/model/canvas';
import type { RepeatChange } from './edits';
import { agentName } from '../../shared/model/queries';
import {
  CONDITIONS,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isRepeatEnds,
  isWait,
  MAX_ROUNDS,
  sameTarget,
  unfit,
  UNTIL_CONDITIONS,
} from '../../shared/model/queue';
import type {
  Condition,
  QueueApproval,
  QueueDelay,
  QueueEntry as ModelQueueEntry,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  QueueWait,
  RepeatedItem,
  RepeatEnds,
  Time,
  Until,
  WaitTarget,
} from '../../shared/model/queue';
import { parseTime, TIME_PRESETS } from '../../shared/model/time';
import { SortableList } from './SortableList';
import type { HandleProps } from './SortableList';
import '../run/run.css';

const EMPTY: readonly QueueItem[] = [];

/** The wait chooser supplies its id until queue.add returns it through the operation. */
export type QueueEntry = ModelQueueEntry & { id?: string };

/** A wait's target (its `index`), whose agent was just picked: next, which of its steps. */
export interface StepChoice {
  waitId: string;
  index: number;
  agent: string;
}

/** An agent a step can act on, or a condition check; `id` undefined is the queue's own agent. */
interface Target {
  id: string | undefined;
  name: string;
}

const nameOf = (node: AgentNode | undefined) =>
  node ? node.data.label || 'Unnamed agent' : 'Deleted agent';

/** Data attributes a row carries: how links mark its task, and where the queues' run is with it. */
export type RowMarks = Readonly<Record<`data-${string}`, string | undefined>>;

/** A button over a task (or a queue's end) that picks it, as what a wait waits for. */
export interface Pick {
  label: string;
  /** Whether it is what the wait waits for now. */
  pressed: boolean;
  onPick: () => void;
}

/** A queue whose items are picked from, as what a wait waits for: `current`, undefined for all. */
export interface Picking {
  /** Its agent's name. */
  name: string;
  current: string | undefined;
  onPick: (item: string | undefined) => void;
}

/** What QueueEditor and QueueRow edit, and with what. */
interface QueueProps {
  node: AgentNode;
  /** Every node of the graph: the agents steps can act on, and their names. */
  nodes: readonly CanvasNode[];
  agent: AdapterId;
  /** What the agent can do. */
  actions: readonly AgentAction[];
  /** `into`: the id of the if-then or repeat to add to. */
  onAdd: (entry: QueueEntry, into?: string) => void;
  onRemove: (itemId: string) => void;
  onMove: (itemId: string, index: number) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
  /** Sets what a step is to do, in the user's words ('' takes it off). */
  onInstruction: (itemId: string, instruction: string) => void;
  /** Expects a step to fail ('fails'), or (undefined) to succeed. */
  onExpect: (itemId: string, expect: QueueStep['expect']) => void;
  onCondition: (ifId: string, condition: Condition) => void;
  onWaitFor: (waitId: string, targets: WaitTarget[]) => void;
  /** Sets a delay's time, or a wait's time limit (`undefined` takes it off). */
  onTime: (itemId: string, time: Time | undefined) => void;
  /** Sets what an OK is on, in the user's words. */
  onApproval: (okId: string, approve: string) => void;
  /** Changes when a repeat stops, how many rounds it runs at most, or what it does then. */
  onRepeat: (repeatId: string, change: RepeatChange) => void;
  /** Ends now the hold the run has this agent at (Go on now), shown on a row marked waiting. */
  onGoOn: (itemId: string) => void;
  /** Answers the hold the run has this agent at for the user, on a row marked to decide. */
  onDecide: (itemId: string, answer: Answer) => void;
  /**
   * Once an agent is picked for a wait, lets the user pick one of its steps (AgentView shows its
   * queue beside). Without it, the wait picker lists their steps too.
   */
  onChooseStep?: (choice: StepChoice) => void;
  /** The wait target being picked, to show which. */
  choosing?: Omit<StepChoice, 'agent'>;
  /**
   * Marks for the row of each item, if-then step and item in a repeat, by id, and (null) the
   * queue's end. Where the run is with a row (`data-run`, `data-until`, `data-decide`,
   * `data-asked`, `data-round`) gives it its run controls: Go on now, a countdown, how to decide,
   * the changes asked for, the round.
   */
  marks?: (itemId: string | null) => RowMarks;
  /**
   * The grid row of each item in a repeat, counted from the first row below the repeat's own (All
   * queues lines them up with the other lanes).
   */
  rowOf?: (itemId: string) => number | undefined;
  /**
   * While a wait's target is picked from this queue: inside a repeat, each item picks, and the
   * repeat's header the whole repeat (QueueEditor and All queues' lanes cover the other items).
   */
  picking?: Picking | undefined;
}

/**
 * An agent's queue, in order: steps (one of the agent's actions, done to an agent: this one unless
 * another is picked), messages (text passed to an agent), if-thens (steps and messages that run
 * only when a condition holds), repeats (steps, messages, waits and delays run in rounds until a
 * condition holds, a few rounds at most), waits (until other agents have finished, or at most a
 * time), delays (a set time, or until a time of day), and OKs (until the user decides about the
 * work before). The ⊕ adds any of them; everything is picked by typing to search. Rows are
 * reordered by dragging their handle, or with the arrow keys on it.
 * With `only`, it shows part of the queue (WorkDetail.tsx), where reordering moves items among
 * those shown.
 */
export function QueueEditor({
  only,
  add = 'anything',
  addLabel = 'Add to queue',
  ...props
}: QueueProps & {
  /** The name of the ⊕ that adds anything. */
  addLabel?: string;
  /** Shows only the items for which this holds (an if-then whole, with all of its steps). */
  only?: (item: QueueItem) => boolean;
  /**
   * What ⊕ adds: anything (the default), nothing (no ⊕), or (`workFor`, an agent's id) one of the
   * agent's actions, aimed at that agent.
   */
  add?: 'anything' | 'nothing' | { workFor: string };
}) {
  const { node, onAdd, onMove, picking } = props;
  const queue = node.data.queue ?? EMPTY;
  const context = contextOf(props);
  const shown = only ? queue.filter(only) : queue;
  const planned = queue.filter((item) => !isMessage(item) || item.submission === undefined);
  const movable = shown.filter((item) => !isMessage(item) || item.submission === undefined);
  /** Moves an item to `index` among those shown: to where the item now there is in the queue. */
  const moveShown = (itemId: string, index: number) => {
    const at = movable[Math.min(Math.max(index, 0), movable.length - 1)];
    if (at) onMove(itemId, planned.indexOf(at));
  };

  return (
    <>
      {shown.length > 0 && (
        <SortableList
          items={shown}
          className="graph-queue"
          onMove={moveShown}
          isMovable={(item) => !isMessage(item) || item.submission === undefined}
          renderItem={(item, handle) => (
            <>
              <ItemRow item={item} handle={handle} context={context} props={props} />
              {picking && !isRepeat(item) && !(isMessage(item) && item.submission) && (
                <PickTask
                  label={`Wait for ${picking.name}: ${context.itemLabel(item)}`}
                  pressed={picking.current === item.id}
                  onPick={() => {
                    picking.onPick(item.id);
                  }}
                />
              )}
            </>
          )}
        />
      )}
      {add === 'anything' && (
        <>
          <QueueEnd
            marks={props.marks?.(null)}
            pick={
              picking && {
                label: `Wait for all of ${picking.name}'s work`,
                pressed: picking.current === undefined,
                onPick: () => {
                  picking.onPick(undefined);
                },
              }
            }
          />
          <AddMenu label={addLabel} place="queue" context={context} onAdd={onAdd} />
        </>
      )}
      {typeof add === 'object' && (
        <AddMenu
          label={`Queue work for ${context.name(add.workFor)}`}
          place="if"
          target={add.workFor}
          context={context}
          onAdd={onAdd}
        />
      )}
    </>
  );
}

/**
 * The end of a queue: what a wait for all of its agent's work waits for. With `pick`, a button
 * over it picks that.
 */
export function QueueEnd({
  marks,
  pick,
}: {
  marks?: RowMarks | undefined;
  pick?: Pick | undefined;
}) {
  return (
    <div className="graph-queue-end" data-end {...marks}>
      End
      {pick && <PickTask {...pick} />}
    </div>
  );
}

/** A button over a task, or a queue's end, that picks it as what a wait waits for. */
export function PickTask({ label, pressed, onPick }: Pick) {
  return (
    <button
      type="button"
      className="graph-queue-pick"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onPick}
    />
  );
}

/**
 * One item of an agent's queue, as QueueEditor shows it, on its own: QueuesView puts each in its
 * row of the lanes. `handle` reorders it (useSortable, sortable.ts).
 */
export function QueueRow({
  item,
  handle,
  ...props
}: QueueProps & { item: QueueItem; handle: HandleProps }) {
  return <ItemRow item={item} handle={handle} context={contextOf(props)} props={props} />;
}

/**
 * An item's row: a step, a message, a wait, a delay, an OK, an if-then with its own steps, or a
 * repeat with what it runs each round.
 */
function ItemRow({
  item,
  handle,
  context,
  props,
}: {
  item: QueueItem;
  handle: HandleProps;
  context: Context;
  props: QueueProps;
}) {
  if (isApproval(item)) return <ApprovalRow item={item} handle={handle} context={context} />;
  if (isRepeat(item)) {
    return (
      <RepeatRow
        item={item}
        handle={handle}
        context={context}
        onMove={props.onMove}
        onAdd={(entry) => {
          props.onAdd(entry, item.id);
        }}
        onRepeat={(change) => {
          props.onRepeat(item.id, change);
        }}
      />
    );
  }
  if (!isIf(item)) return <RepeatedRow item={item} handle={handle} context={context} />;
  return (
    <IfRow
      item={item}
      handle={handle}
      context={context}
      onMove={props.onMove}
      onAdd={(entry) => {
        props.onAdd(entry, item.id);
      }}
      onCondition={(condition) => {
        props.onCondition(item.id, condition);
      }}
    />
  );
}

/** The row of a step, a message, a wait or a delay: what a repeat holds. */
function RepeatedRow({
  item,
  handle,
  context,
}: {
  item: RepeatedItem;
  handle: HandleProps;
  context: Context;
}) {
  if (isWait(item)) return <WaitRow item={item} handle={handle} context={context} />;
  if (isDelay(item)) return <DelayRow item={item} handle={handle} context={context} />;
  return isMessage(item) ? (
    <MessageRow item={item} handle={handle} context={context} />
  ) : (
    <StepRow item={item} handle={handle} context={context} />
  );
}

/** What every row needs to show and change its item. */
function contextOf({
  node,
  nodes,
  agent,
  actions,
  onRemove,
  onRetarget,
  onEditMessage,
  onInstruction,
  onExpect,
  onWaitFor,
  onTime,
  onApproval,
  onGoOn,
  onDecide,
  onChooseStep,
  choosing,
  marks,
  rowOf,
  picking,
}: QueueProps): Context {
  const others = nodes.filter((n) => n.type === 'agent').filter((n) => n.id !== node.id);
  const engine = runCatalog();
  const name = (id: string | undefined) => (id === undefined ? 'this agent' : agentName(nodes, id));
  const targetLabel = (target: WaitTarget) => waitTargetLabel(nodes, target, engine);
  const queue = (node.data.queue ?? EMPTY).filter(
    (item) => !isMessage(item) || item.submission === undefined,
  );
  return {
    owner: node.id,
    inRepeat: false,
    agent,
    usage: backendOfType(loadedCatalog(), agent),
    catalog: engine,
    actions,
    others,
    name,
    ifText: (condition) => ifText(condition, engine),
    untilText: (until) => untilText(nodes, until),
    itemLabel: (item) => itemLabel(item, engine),
    targetLabel,
    describe: (item) => describe(nodes, item, engine),
    onRemove,
    onRetarget,
    onEditMessage,
    onInstruction,
    onExpect,
    onWaitFor,
    onTime,
    onApproval,
    onGoOn,
    onDecide,
    unfit: (item) =>
      unfit(
        queue,
        queue.findIndex((q) => q.id === item.id),
      ),
    marks: marks ?? (() => ({})),
    ...(onChooseStep ? { onChooseStep } : {}),
    ...(choosing ? { choosing } : {}),
    ...(rowOf ? { rowOf } : {}),
    ...(picking ? { picking } : {}),
  };
}

/**
 * What the ⊕ and its menus need: whose queue it is (`owner`), whether they add inside a repeat, the
 * agent's actions, the other agents, and how items read.
 */
interface AddContext {
  owner: string;
  inRepeat: boolean;
  /**
   * The backend the agent's type is, if corrallm reads its usage: an If can check it, and a delay
   * wait for its usage window to reset.
   */
  usage?: UsageBackendId | undefined;
  /** What names a usage backend in the queue's words: the run's catalog (runCatalog). */
  catalog: EngineCatalog;
  actions: readonly AgentAction[];
  others: readonly AgentNode[];
  itemLabel: (item: QueueItem) => string;
  onChooseStep?: (choice: StepChoice) => void;
}

interface Context extends AddContext {
  agent: AdapterId;
  name: (id: string | undefined) => string;
  ifText: (condition: Condition) => string;
  untilText: (until: Until) => string;
  targetLabel: (target: WaitTarget) => string;
  describe: (item: QueueItem) => string;
  onRemove: (itemId: string) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
  onInstruction: (itemId: string, instruction: string) => void;
  onExpect: (itemId: string, expect: QueueStep['expect']) => void;
  onWaitFor: (waitId: string, targets: WaitTarget[]) => void;
  onTime: (itemId: string, time: Time | undefined) => void;
  onApproval: (okId: string, approve: string) => void;
  onGoOn: (itemId: string) => void;
  onDecide: (itemId: string, answer: Answer) => void;
  /** Why an if-then's condition cannot hold where it sits, or undefined if it can. */
  unfit: (item: QueueIf) => string | undefined;
  choosing?: Omit<StepChoice, 'agent'>;
  marks: (itemId: string) => RowMarks;
  rowOf?: (itemId: string) => number | undefined;
  picking?: Picking;
}

/**
 * A ⊕ that adds to an agent's queue (`node`'s), apart from the queue: AgentView puts one right
 * above the message box, as well as the queue's own beside, its menus opening upwards (`up`);
 * QueuesView puts one at the end of each lane.
 */
export function QueueAddMenu({
  node,
  nodes,
  actions,
  label = 'Add to queue',
  up = true,
  onAdd,
  onChooseStep,
}: {
  node: AgentNode;
  nodes: readonly CanvasNode[];
  actions: readonly AgentAction[];
  /** Its name, telling it from the queue's own ⊕. */
  label?: string;
  up?: boolean;
  onAdd: (entry: QueueEntry) => void;
  onChooseStep?: (choice: StepChoice) => void;
}) {
  const others = nodes.filter((n) => n.type === 'agent').filter((n) => n.id !== node.id);
  const engine = runCatalog();
  const context = {
    owner: node.id,
    inRepeat: false,
    usage: backendOfType(loadedCatalog(), node.data.adapter ?? DEFAULT_AGENT),
    catalog: engine,
    actions,
    others,
    itemLabel: (item: QueueItem) => itemLabel(item, engine),
    ...(onChooseStep ? { onChooseStep } : {}),
  };
  return <AddMenu label={label} place="queue" up={up} context={context} onAdd={onAdd} />;
}

/**
 * Picks an agent by typing: "This agent" first, unless `withSelf` is false. Agents in `exclude`
 * (ids) are not offered.
 */
function TargetPicker({
  context,
  label = 'On which agent?',
  withSelf = true,
  exclude = [],
  onPick,
  onCancel,
}: {
  context: AddContext;
  label?: string;
  withSelf?: boolean;
  exclude?: readonly string[];
  onPick: (target: Target) => void;
  onCancel: () => void;
}) {
  const targets: Target[] = [
    ...(withSelf ? [{ id: undefined, name: 'This agent' }] : []),
    ...context.others
      .filter((n) => !exclude.includes(n.id))
      .map((n) => ({ id: n.id, name: nameOf(n) })),
  ];
  return (
    <SearchPicker
      label={label}
      placeholder="Search agents…"
      options={targets}
      optionLabel={(target) => target.name}
      optionKey={(target) => target.id ?? '(this agent)'}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/** A dropdown with a text box: Enter submits (in a multi-line one, Shift+Enter is a new line). */
function TextPrompt({
  label,
  multiline = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  multiline?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const props = {
    'aria-label': label,
    placeholder: label,
    autoFocus: true,
    value: text,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(event.target.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (text.trim() !== '') onSubmit(text.trim());
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    },
  };
  return (
    <div
      ref={root}
      className="search-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onCancel();
      }}
    >
      {multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
    </div>
  );
}

const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Picks a time by typing: a length, or a time of day (src/shared/model/time.ts reads what is typed, and lists what
 * it can mean first), or one of the presets. With `current`, its words are typed in to start
 * from. With `allowNone`, "No time limit" comes first, which picks undefined.
 */
function TimePicker({
  label,
  current,
  allowNone = false,
  usage,
  catalog,
  onPick,
  onCancel,
}: {
  label: string;
  current?: Time;
  allowNone?: boolean;
  /** A backend whose usage windows' resets are offered too (a delay's, for an agent on it). */
  usage?: UsageBackendId | undefined;
  /** What names a usage backend in a time's words. */
  catalog: EngineCatalog;
  onPick: (time: Time | undefined) => void;
  onCancel: () => void;
}) {
  const options: (Time | null)[] = [
    ...(allowNone ? [null] : []),
    ...TIME_PRESETS,
    ...(usage === undefined
      ? []
      : USAGE_WINDOWS.map((resets): Time => ({ resets, backend: usage }))),
  ];
  return (
    <SearchPicker
      label={label}
      placeholder="10 minutes, 1 hour, until 9:00…"
      options={options}
      optionLabel={(time) => (time === null ? 'No time limit' : upper(timeText(time, catalog)))}
      optionKey={(time) => (time === null ? '(none)' : JSON.stringify(time))}
      typed={parseTime}
      {...(current ? { initialQuery: timeText(current, catalog) } : {})}
      onPick={(time) => {
        onPick(time ?? undefined);
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * How long is left until a time (`until`, epoch ms) that holds a row in the run, counting down
 * each second. Keyed by `until`, so a changed time starts afresh.
 */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <span className="graph-queue-left" role="timer">
      {leftText(until - now)}
    </span>
  );
}

/** A row's countdown, while the run holds the agent at it until a time (its `data-until`). */
function RowCountdown({ id, context }: { id: string; context: Context }) {
  const until = context.marks(id)['data-until'];
  return until === undefined ? null : <Countdown key={until} until={Number(until)} />;
}

/** Go on now: ends the hold the run has the agent at, on a row the run holds it at (waiting). */
function GoOn({ item, context }: { item: QueueItem; context: Context }) {
  if (context.marks(item.id)['data-run'] !== 'waiting') return null;
  return (
    <button
      type="button"
      className="graph-queue-goon"
      aria-label={`Go on now: ${context.describe(item)}`}
      title="Stop waiting, and go on with the queue"
      onClick={() => {
        context.onGoOn(item.id);
      }}
    >
      Go on now
    </button>
  );
}

function Handle({
  handle,
  item,
  context,
}: {
  handle: HandleProps;
  item: QueueItem;
  context: Context;
}) {
  return (
    <button
      type="button"
      className="graph-queue-handle"
      aria-label={`Move ${context.describe(item)}`}
      title="Drag, or use the arrow keys, to reorder"
      {...handle}
    />
  );
}

function RemoveButton({ item, context }: { item: QueueItem; context: Context }) {
  return (
    <button
      type="button"
      className="graph-queue-remove"
      aria-label={`Remove ${context.describe(item)}`}
      onClick={() => {
        context.onRemove(item.id);
      }}
    />
  );
}

/** The agent a step acts on, or a message goes to: a chip that changes it. */
function TargetChip({
  item,
  label,
  context,
}: {
  item: QueueStep | QueueMessage;
  label: string;
  context: Context;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="graph-queue-target"
        data-own={item.target === undefined ? '' : undefined}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        → {context.name(item.target)}
      </button>
      {open && (
        <TargetPicker
          context={context}
          onPick={(target) => {
            context.onRetarget(item.id, target.id);
            setOpen(false);
          }}
          onCancel={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** What a step can be expected to do: succeed, as steps do, or fail. */
const EXPECT = [
  { expect: undefined, label: 'Succeed', detail: 'As any step: failing fails it' },
  {
    expect: 'fails',
    label: 'Fail',
    detail: 'Red before green: failing is its success, and passing its failure',
  },
] as const;

/** Picks what a step is expected to do: succeed, as steps do, or fail. */
function ExpectPicker({
  item,
  context,
  onClose,
}: {
  item: QueueStep;
  context: Context;
  onClose: () => void;
}) {
  return (
    <SearchPicker
      label="Expect it to…"
      options={EXPECT}
      optionLabel={(option) => option.label}
      optionDetail={(option) => option.detail}
      optionKey={(option) => option.label}
      onPick={(option) => {
        context.onExpect(item.id, option.expect);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

/**
 * A step expected to fail, on a line of its own under the step: "expect: fails", a chip that
 * changes it, and once the run has judged it (its row's `data-expected`), how that went: failed,
 * as expected, or passed.
 */
function Expectation({
  item,
  context,
  open,
  onToggle,
}: {
  item: QueueStep;
  context: Context;
  open: boolean;
  onToggle: () => void;
}) {
  const expected = context.marks(item.id)['data-expected'];
  return (
    <div className="graph-queue-expectation">
      <button
        type="button"
        className="graph-queue-target graph-queue-expect"
        aria-label={`Change what ${item.action} is expected to do: fail`}
        title="Failing is its success, and passing its failure"
        aria-expanded={open}
        onClick={onToggle}
      >
        expect: fails
      </button>
      {expected !== undefined && (
        <span className="graph-queue-expected" data-expected={expected}>
          {expectedText(expected === 'met')}
        </span>
      )}
    </div>
  );
}

/**
 * A step: its handle, its action, what it is to do (in the user's words, edited in place: a slash
 * command's arguments), the agent it acts on (a chip that changes it), and remove. A tool's action
 * also says what the step is expected to do (it takes no room on the line: a slash command's turn
 * is not judged pass or fail, so it has none); expected to fail, a line under the step says so,
 * and, once the run has judged it, how that went.
 */
function StepRow({
  item,
  handle,
  context,
}: {
  item: QueueStep;
  handle: HandleProps;
  context: Context;
}) {
  const [expecting, setExpecting] = useState(false);
  const instruction = useDraft(
    item.instruction ?? '',
    (text) => {
      context.onInstruction(item.id, text);
    },
    { multiline: true },
  );
  const known = context.actions.some((a) => a.name === item.action);
  const command = item.action.startsWith('/');
  const fails = item.expect === 'fails';
  const unknown = known ? {} : { title: `${context.agent} has no ${item.action}` };
  const toggle = () => {
    setExpecting(!expecting);
  };
  return (
    <div
      className={known ? 'graph-queue-row' : 'graph-queue-row unavailable'}
      {...context.marks(item.id)}
    >
      <Handle handle={handle} item={item} context={context} />
      {command ? (
        <span className="graph-queue-action" {...unknown}>
          {item.action}
        </span>
      ) : (
        <button
          type="button"
          className="graph-queue-action"
          aria-label={`Change what ${item.action} is expected to do`}
          title={
            fails
              ? 'Change what it is expected to do'
              : 'Expect it to fail, as tests written to fail first do'
          }
          {...unknown}
          aria-expanded={expecting}
          onClick={toggle}
        >
          {item.action}
        </button>
      )}{' '}
      <textarea
        className="graph-queue-instruction"
        rows={1}
        aria-label={command ? `Arguments for ${item.action}` : `What ${item.action} is to do`}
        placeholder={command ? 'Arguments' : 'What to do'}
        {...instruction}
      />
      <TargetChip item={item} label={`Change the agent ${item.action} acts on`} context={context} />
      <RowCountdown id={item.id} context={context} />
      <GoOn item={item} context={context} />
      <RemoveButton item={item} context={context} />
      <UsageHeld item={item} context={context} />
      <TaskResult item={item} context={context} />
      {fails && <Expectation item={item} context={context} open={expecting} onToggle={toggle} />}
      {expecting && (
        <ExpectPicker
          item={item}
          context={context}
          onClose={() => {
            setExpecting(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Where a usage rule holds the run before a task (its row's `data-usage`): why, and while it asks
 * the user, how to decide (Go on, Wait for the reset, Stop here), shown without pointing at it.
 */
function UsageHeld({ item, context }: { item: QueueStep | QueueMessage; context: Context }) {
  const marks = context.marks(item.id);
  const why = marks['data-usage'];
  const backend = marks['data-usage-backend'];
  if (why === undefined || backend === undefined) return null;
  const reset = marks['data-usage-reset'];
  return (
    <>
      <span className="graph-queue-usage">{why}</span>
      {marks['data-decide'] !== undefined && (
        <DecideBar
          item={item}
          answers={usageAnswers(
            { backend, resetsAt: reset === undefined ? null : Number(reset) },
            context.catalog,
          )}
          onDecide={(answer) => {
            context.onDecide(item.id, answer);
          }}
        />
      )}
    </>
  );
}

/** A row's recovery problem, projected by queueMarks from the run. */
function problemOf(marks: RowMarks): TaskProblem | undefined {
  const kind = marks['data-problem'];
  if (kind !== 'failed' && kind !== 'uncertain' && kind !== 'cancelled') return undefined;
  const conditionKey = marks['data-problem-condition'];
  return {
    kind,
    reason: marks['data-problem-reason'] ?? 'unknown',
    text: marks['data-problem-text'] ?? '',
    agent: marks['data-problem-agent'] ?? '',
    ...(conditionKey === undefined ? {} : { conditionKey }),
  };
}

/** The task's concise attempt record and recovery choices, beside the original task. */
function TaskResult({
  item,
  context,
  controls = true,
}: {
  item: QueueItem;
  context: Context;
  controls?: boolean;
}) {
  const marks = context.marks(item.id);
  const problem = problemOf(marks);
  const attempts = marks['data-attempts']
    ? (JSON.parse(marks['data-attempts']) as TaskAttempt[])
    : [];
  if (!problem && attempts.length === 0) return null;
  const latest = attempts.at(-1);
  const label = (status: string) =>
    status === 'running' && marks['data-refused'] !== undefined
      ? 'Not sent'
      : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <div className="graph-queue-result">
      {problem && <p className="graph-queue-problem">{problem.text}</p>}
      {attempts.length > 0 && (
        <details className="graph-queue-attempts">
          <summary>
            <span>
              {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'}
            </span>
            <span>
              {label(latest?.status ?? '')}
              {latest?.reason ? ` · ${latest.reason.replace(/[_-]/g, ' ')}` : ''}
            </span>
          </summary>
          <ol>
            {attempts.map((attempt, index) => (
              <li key={attempt.id}>
                <span>
                  Attempt {index + 1} · {label(attempt.status)}
                </span>
                <time dateTime={new Date(attempt.startedAt).toISOString()}>
                  {new Date(attempt.startedAt).toLocaleTimeString()}
                </time>
                {attempt.endedAt !== undefined && (
                  <>
                    {' – '}
                    <time dateTime={new Date(attempt.endedAt).toISOString()}>
                      {new Date(attempt.endedAt).toLocaleTimeString()}
                    </time>
                  </>
                )}
                {attempt.text && <p>{attempt.text}</p>}
                {!attempt.text && attempt.reason && <p>{attempt.reason.replace(/[_-]/g, ' ')}</p>}
                {attempt.message && (
                  <p>
                    You asked: <span>{attempt.message}</span>
                  </p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {controls && problem && marks['data-decide'] !== undefined && (
        <DecideBar
          item={item}
          problem={problem}
          onDecide={(answer) => {
            context.onDecide(item.id, answer);
          }}
        />
      )}
    </div>
  );
}

/** A message: the agent it goes to (a chip that changes it), and its text, edited in place. */
function MessageRow({
  item,
  handle,
  context,
}: {
  item: QueueMessage;
  handle: HandleProps;
  context: Context;
}) {
  const message = useDraft(
    item.message,
    (text) => {
      context.onEditMessage(item.id, text);
    },
    { multiline: true },
  );
  if (item.submission) {
    const { status, images, unresolved } = item.submission;
    return (
      <div
        className="graph-queue-row graph-queue-message graph-queue-submission"
        {...context.marks(item.id)}
        data-run={status}
        data-submission={item.submission.id}
        data-unresolved={unresolved ? '' : undefined}
      >
        <span className="graph-queue-keyword">Message</span>
        <span
          className="graph-queue-submission-status"
          title={
            unresolved
              ? 'Inspect the native conversation; this submission was not replayed.'
              : status === 'completed'
                ? 'The agent’s turn ended.'
                : undefined
          }
        >
          {unresolved ? 'Unresolved' : status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
        {(images?.length ?? 0) > 0 && (
          <span className="graph-queue-submission-images">
            {images?.length} {images?.length === 1 ? 'image' : 'images'}
          </span>
        )}
        <p className="graph-queue-submission-text">{item.message}</p>
      </div>
    );
  }
  return (
    <div className="graph-queue-row graph-queue-message" {...context.marks(item.id)}>
      <Handle handle={handle} item={item} context={context} />
      <span className="graph-queue-keyword">Message</span>
      <TargetChip item={item} label="Change the agent the message goes to" context={context} />
      <textarea
        aria-label="Message to the agent"
        placeholder="Tell the agent what to do"
        {...message}
      />
      <RowCountdown id={item.id} context={context} />
      <GoOn item={item} context={context} />
      <RemoveButton item={item} context={context} />
      <UsageHeld item={item} context={context} />
      <TaskResult item={item} context={context} />
    </div>
  );
}

/**
 * What a wait can wait for: each other agent (all of its work), then each item in its queue, and
 * each item in a repeat there: each round of it for a wait in a repeat (`context.inRepeat`), or
 * once its repeat is over.
 */
function waitOptions(context: AddContext) {
  const option = (agent: AgentNode, item: QueueItem, detail: string) => ({
    target: { agent: agent.id, item: item.id },
    label: `${nameOf(agent)}: ${context.itemLabel(item)}`,
    detail,
  });
  return context.others.flatMap((agent) => [
    { target: { agent: agent.id }, label: nameOf(agent), detail: 'All of its work' },
    ...(agent.data.queue ?? [])
      .filter((item) => !isMessage(item) || item.submission === undefined)
      .flatMap((item) =>
        isRepeat(item)
          ? [
              option(agent, item, 'All of its rounds'),
              ...item.repeat.map((inner) =>
                option(
                  agent,
                  inner,
                  context.inRepeat ? 'This step, each round' : 'This step, once its repeat is over',
                ),
              ),
            ]
          : [option(agent, item, 'Just this step')],
      ),
  ]);
}

/** Picks what to wait for by typing: an agent, or a step in its queue (not one in `exclude`). */
function WaitPicker({
  context,
  exclude = [],
  onPick,
  onCancel,
}: {
  context: AddContext;
  exclude?: readonly WaitTarget[];
  onPick: (target: WaitTarget) => void;
  onCancel: () => void;
}) {
  const options = waitOptions(context).filter(
    (option) => !exclude.some((target) => sameTarget(target, option.target)),
  );
  return (
    <SearchPicker
      label="Wait for which agent or step?"
      placeholder="Search agents and their steps…"
      options={options}
      optionLabel={(option) => option.label}
      optionDetail={(option) => option.detail}
      optionKey={(option) => JSON.stringify(option.target)}
      onPick={(option) => {
        onPick(option.target);
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * A wait: what it waits for (agents, or steps in their queues), each with a button that takes it
 * off (but the last), a button that adds another, and its time limit (a chip that changes it, or
 * one that adds one). With `onChooseStep`, a target's chip picks its step again, and an added
 * target's agent is picked first, then its step. While the run holds the agent at it: Go on now,
 * and with a limit, how long is left.
 */
function WaitRow({
  item,
  handle,
  context,
}: {
  item: QueueWait;
  handle: HandleProps;
  context: Context;
}) {
  const [adding, setAdding] = useState(false);
  const [timing, setTiming] = useState(false);
  const { onChooseStep } = context;
  /** Agents it already waits for all the work of. */
  const whole = item.waitFor.flatMap((target) => (target.item === undefined ? [target.agent] : []));
  const more = onChooseStep
    ? context.others.some((n) => !whole.includes(n.id))
    : waitOptions(context).some(
        (option) => !item.waitFor.some((target) => sameTarget(target, option.target)),
      );
  const picking = context.choosing?.waitId === item.id ? context.choosing.index : undefined;
  return (
    <div
      className={
        picking === undefined
          ? 'graph-queue-row graph-queue-wait'
          : 'graph-queue-row graph-queue-wait choosing'
      }
      {...context.marks(item.id)}
    >
      <Handle handle={handle} item={item} context={context} />
      <span className="graph-queue-keyword">Wait for</span>
      {item.waitFor.map((target, index) => (
        <span
          key={JSON.stringify(target)}
          className={index === picking ? 'graph-queue-waited choosing' : 'graph-queue-waited'}
        >
          {onChooseStep ? (
            <button
              type="button"
              className="graph-queue-waited-pick"
              aria-label={`Change what it waits for: ${context.targetLabel(target)}`}
              title="Pick another step to wait for"
              onClick={() => {
                onChooseStep({ waitId: item.id, index, agent: target.agent });
              }}
            >
              {context.targetLabel(target)}
            </button>
          ) : (
            context.targetLabel(target)
          )}
          {item.waitFor.length > 1 && (
            <button
              type="button"
              className="graph-queue-unwait"
              aria-label={`Stop waiting for ${context.targetLabel(target)}`}
              onClick={() => {
                context.onWaitFor(
                  item.id,
                  item.waitFor.filter((t) => !sameTarget(t, target)),
                );
              }}
            />
          )}
        </span>
      ))}
      {more && (
        <button
          type="button"
          className="graph-queue-target"
          aria-label="Wait for something else"
          data-more
          title="Wait for another agent or step too"
          aria-expanded={adding}
          onClick={() => {
            setAdding(!adding);
          }}
        >
          +
        </button>
      )}
      {item.timeout === undefined ? (
        <button
          type="button"
          className="graph-queue-target graph-queue-limit"
          aria-label="Add a time limit"
          data-more
          title="Go on anyway if it is not done in time"
          aria-expanded={timing}
          onClick={() => {
            setTiming(!timing);
          }}
        >
          at most…
        </button>
      ) : (
        <button
          type="button"
          className="graph-queue-target"
          aria-label={`Change the time limit: ${limitText(item.timeout, context.catalog)}`}
          aria-expanded={timing}
          onClick={() => {
            setTiming(!timing);
          }}
        >
          {limitText(item.timeout, context.catalog)}
        </button>
      )}
      <RowCountdown id={item.id} context={context} />
      <GoOn item={item} context={context} />
      <RemoveButton item={item} context={context} />
      <TaskResult item={item} context={context} />
      {timing && (
        <TimePicker
          label="Go on anyway after…"
          allowNone={item.timeout !== undefined}
          catalog={context.catalog}
          onPick={(time) => {
            context.onTime(item.id, time);
            setTiming(false);
          }}
          onCancel={() => {
            setTiming(false);
          }}
        />
      )}
      {adding && onChooseStep && (
        <TargetPicker
          context={context}
          label="Wait for which agent?"
          withSelf={false}
          exclude={whole}
          onPick={(target) => {
            setAdding(false);
            if (target.id === undefined) return;
            context.onWaitFor(item.id, [...item.waitFor, { agent: target.id }]);
            onChooseStep({ waitId: item.id, index: item.waitFor.length, agent: target.id });
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      )}
      {adding && !onChooseStep && (
        <WaitPicker
          context={context}
          exclude={item.waitFor}
          onPick={(target) => {
            context.onWaitFor(item.id, [...item.waitFor, target]);
            setAdding(false);
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * A delay: "Wait" and how long, or until when (a chip that changes it). While the run holds the
 * agent at it: how long is left, and Go on now.
 */
function DelayRow({
  item,
  handle,
  context,
}: {
  item: QueueDelay;
  handle: HandleProps;
  context: Context;
}) {
  const [editing, setEditing] = useState(false);
  const text = timeText(item.delay, context.catalog);
  return (
    <div className="graph-queue-row graph-queue-delay" {...context.marks(item.id)}>
      <Handle handle={handle} item={item} context={context} />
      <span className="graph-queue-keyword">Wait</span>
      <button
        type="button"
        className="graph-queue-target"
        aria-label={`Change how long it waits: ${text}`}
        aria-expanded={editing}
        onClick={() => {
          setEditing(!editing);
        }}
      >
        {text}
      </button>
      <RowCountdown id={item.id} context={context} />
      <GoOn item={item} context={context} />
      <RemoveButton item={item} context={context} />
      {editing && (
        <TimePicker
          label="Wait how long?"
          current={item.delay}
          usage={context.usage}
          catalog={context.catalog}
          onPick={(time) => {
            if (time) context.onTime(item.id, time);
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      )}
      <TaskResult item={item} context={context} />
    </div>
  );
}

/** What an OK can be on, besides what is typed: the work before it. */
const OK_ON = [{ label: 'The work before it', approve: '' }] as const;

/**
 * Picks what an OK is on: the work before it, or what is typed, in the user's own words. With
 * `current`, its words are typed in to start from.
 */
function OkPicker({
  current = '',
  onPick,
  onCancel,
}: {
  current?: string;
  onPick: (approve: string) => void;
  onCancel: () => void;
}) {
  return (
    <SearchPicker
      label="Your OK on…"
      placeholder="What you check, e.g. the spec in SPEC.md…"
      options={OK_ON}
      optionLabel={(option) => option.label}
      optionKey={(option) => option.label}
      initialQuery={current.trim()}
      freeText={{ detail: 'In your own words', onPick }}
      onPick={(option) => {
        onPick(option.approve);
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * An OK: "Your OK on" what the user checks (a chip that changes it). Under it, the changes last
 * asked for there, this run; and while the run holds the queue there for the user, how to answer
 * (DecideBar), shown without pointing at it.
 */
function ApprovalRow({
  item,
  handle,
  context,
}: {
  item: QueueApproval;
  handle: HandleProps;
  context: Context;
}) {
  const [editing, setEditing] = useState(false);
  const marks = context.marks(item.id);
  const what = okWhat(item);
  const asked = marks['data-asked'];
  const times = marks['data-asked-times'];
  return (
    <div className="graph-queue-row graph-queue-ok" {...marks}>
      <Handle handle={handle} item={item} context={context} />
      <span className="graph-queue-keyword">Your OK on</span>
      <button
        type="button"
        className="graph-queue-target"
        aria-label={`Change what you OK: ${what}`}
        aria-expanded={editing}
        onClick={() => {
          setEditing(!editing);
        }}
      >
        {what}
      </button>
      <RemoveButton item={item} context={context} />
      {asked !== undefined && (
        <span className="graph-queue-ok-asked" title={asked}>
          You asked: “{threadTitle(asked, 80)}”{times === undefined ? '' : ` (${times} times)`}
        </span>
      )}
      {marks['data-decide'] !== undefined && (
        <DecideBar
          item={item}
          problem={problemOf(marks)}
          onDecide={(answer) => {
            context.onDecide(item.id, answer);
          }}
        />
      )}
      {editing && (
        <OkPicker
          current={item.approve}
          onPick={(approve) => {
            context.onApproval(item.id, approve);
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      )}
      <TaskResult item={item} context={context} controls={false} />
    </div>
  );
}

/**
 * How to answer at an item the run holds its queue at for the user (src/shared/engine/run/asks.ts answersOf): the
 * primary choice, filled; an answer in the user's own words, in a multi-line prompt (Enter sends,
 * Shift+Enter starts a new line, Esc cancels); then the other choices. Shown on the row whenever
 * the run waits for the user, never hidden. A plain div, so All queues' groups stay as they are.
 */
export function DecideBar({
  item,
  answers: given,
  problem,
  onDecide,
}: {
  item: QueueItem;
  /** How to answer, where it is not the item's own (a usage rule's hold before a task). */
  answers?: Answers;
  problem?: TaskProblem | undefined;
  onDecide: (answer: Answer) => void;
}) {
  const [replying, setReplying] = useState(false);
  const answers = given ?? answersOf(item, problem);
  if (!answers) return null;
  const { choices, reply } = answers;
  const button = (choice: (typeof choices)[number]) => (
    <button
      key={choice.key}
      type="button"
      data-primary={choice.primary ? '' : undefined}
      {...(choice.title === undefined ? {} : { title: choice.title })}
      onClick={() => {
        onDecide({ choice: choice.key });
      }}
    >
      {choice.label}
    </button>
  );
  return (
    <div className="graph-queue-decide">
      {choices.filter((choice) => choice.primary).map(button)}
      {reply && (
        <button
          type="button"
          aria-expanded={replying}
          onClick={() => {
            setReplying(!replying);
          }}
        >
          {reply.button}…
        </button>
      )}
      {choices.filter((choice) => !choice.primary).map(button)}
      {replying && reply && (
        <TextPrompt
          label={reply.label}
          multiline
          onSubmit={(text) => {
            setReplying(false);
            onDecide({ reply: text });
          }}
          onCancel={() => {
            setReplying(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * An if-then: "If <condition> then" (the condition a chip that changes it, struck through with
 * the reason as its title when it cannot hold where it sits), and its steps.
 */
function IfRow({
  item,
  handle,
  context,
  onMove,
  onAdd,
  onCondition,
}: {
  item: QueueIf;
  handle: HandleProps;
  context: Context;
  onMove: (itemId: string, index: number) => void;
  onAdd: (entry: QueueEntry) => void;
  onCondition: (condition: Condition) => void;
}) {
  const [editing, setEditing] = useState(false);
  const text = context.ifText(item.if);
  const reason = context.unfit(item);
  return (
    <div className="graph-queue-if" {...context.marks(item.id)}>
      <div className="graph-queue-row">
        <Handle handle={handle} item={item} context={context} />
        <span className="graph-queue-keyword">If</span>
        <button
          type="button"
          className="graph-queue-target"
          aria-label={`Change the condition: ${text}`}
          data-unavailable={reason === undefined ? undefined : ''}
          {...(reason === undefined ? {} : { title: reason })}
          aria-expanded={editing}
          onClick={() => {
            setEditing(!editing);
          }}
        >
          {text}
        </button>
        <span className="graph-queue-keyword">then</span>
        <RemoveButton item={item} context={context} />
        <TaskResult item={item} context={context} />
        {editing && (
          <ConditionPicker
            current={item.if}
            usage={context.usage}
            catalog={context.catalog}
            onPick={(condition) => {
              if (condition.kind !== 'repeatEnds') onCondition(condition);
              setEditing(false);
            }}
            onCancel={() => {
              setEditing(false);
            }}
          />
        )}
      </div>
      {item.then.length > 0 && (
        <SortableList
          items={item.then}
          className="graph-queue graph-queue-then"
          label={`Then: ${text}`}
          onMove={onMove}
          renderItem={(step, stepHandle) => (
            <RepeatedRow item={step} handle={stepHandle} context={context} />
          )}
        />
      )}
      <AddMenu label={`Add to If ${text}`} place="if" context={context} onAdd={onAdd} />
    </div>
  );
}

type Choice =
  | { kind: 'if' }
  | { kind: 'repeat' }
  | { kind: 'wait' }
  | { kind: 'delay' }
  | { kind: 'ok' }
  | { kind: 'message' }
  | { kind: 'action'; action: AgentAction };

const CHOICE_TEXT = {
  if: ['If… then', 'Run steps only when a condition holds'],
  repeat: ['Repeat until…', 'Loop: run steps again until a condition holds, a few rounds at most'],
  wait: ['Wait for…', 'Go on only once other agents have finished'],
  delay: ['Wait a while…', 'Go on after a set time, or at a time of day'],
  ok: ['Wait for your OK…', 'Hold here until you approve, ask for changes, or stop'],
  message: ['Message', 'Tell an agent something'],
} as const;

/** Where a ⊕ adds: to the queue itself, to what a repeat holds, or to an if-then's steps. */
type Place = 'queue' | 'repeat' | 'if';

/**
 * What may sit where, in the order the ⊕ offers it, before the agent's actions (which go
 * anywhere). The file's reader (src/shared/model/file.ts) rejects the rest ("an if-then cannot hold …", "a repeat cannot hold …").
 */
const PLACES: Readonly<Record<Place, readonly (keyof typeof CHOICE_TEXT)[]>> = {
  queue: ['if', 'repeat', 'wait', 'delay', 'ok', 'message'],
  repeat: ['wait', 'delay', 'message'],
  if: ['message'],
};

/**
 * The ⊕ and its dropdowns: what may be added in its `place` (PLACES), then the agent an action
 * acts on (unless `target` fixes it), the message's text, the if-then's condition, when a repeat
 * stops, the agent to wait for, how long to wait, or what an OK is on.
 */
function AddMenu({
  label,
  place,
  up = false,
  target,
  context: given,
  onAdd,
}: {
  label: string;
  place: Place;
  /** Whether its menus open above it, for a ⊕ at the bottom of the view. */
  up?: boolean;
  /** The agent every action and message added is aimed at; by default, the queue's own. */
  target?: string;
  context: AddContext;
  onAdd: (entry: QueueEntry) => void;
}) {
  // A wait added to a repeat waits round by round.
  const context = place === 'repeat' ? { ...given, inRepeat: true } : given;
  const [step, setStep] = useState<
    'closed' | 'choose' | 'condition' | 'until' | 'wait' | 'delay' | 'ok' | 'message' | AgentAction
  >('closed');
  const close = () => {
    setStep('closed');
  };
  const choices: Choice[] = [
    ...PLACES[place].map((kind) => ({ kind })),
    ...context.actions.map((action) => ({ kind: 'action' as const, action })),
  ];
  return (
    <div className={up ? 'graph-queue-add up' : 'graph-queue-add'}>
      <button
        type="button"
        className="graph-queue-plus"
        aria-label={label}
        title={label}
        aria-expanded={step !== 'closed'}
        onClick={() => {
          setStep(step === 'closed' ? 'choose' : 'closed');
        }}
      />
      {step === 'choose' && (
        <SearchPicker
          label={label}
          options={choices}
          optionLabel={(choice) =>
            choice.kind === 'action' ? choice.action.name : CHOICE_TEXT[choice.kind][0]
          }
          optionDetail={(choice) =>
            choice.kind === 'action' ? choice.action.description : CHOICE_TEXT[choice.kind][1]
          }
          optionKey={(choice) =>
            choice.kind === 'action' ? choice.action.name : `(${choice.kind})`
          }
          onPick={(choice) => {
            if (choice.kind === 'action' && target !== undefined) {
              onAdd({ action: choice.action.name, target });
              close();
              return;
            }
            setStep(
              choice.kind === 'if'
                ? 'condition'
                : choice.kind === 'repeat'
                  ? 'until'
                  : choice.kind === 'action'
                    ? choice.action
                    : choice.kind,
            );
          }}
          onCancel={close}
        />
      )}
      {step === 'condition' && (
        <ConditionPicker
          usage={context.usage}
          catalog={context.catalog}
          onPick={(condition) => {
            if (condition.kind !== 'repeatEnds') onAdd({ if: condition, then: [] });
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'until' && (
        <ConditionPicker
          mode="until"
          leaders={leaderOptions(context, undefined)}
          catalog={context.catalog}
          onPick={(until) => {
            if (until.kind !== 'timedOut' && until.kind !== 'usageAbove') {
              onAdd({ repeat: [], until, rounds: DEFAULT_ROUNDS, otherwise: 'ask' });
            }
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'wait' && context.onChooseStep && (
        <TargetPicker
          context={context}
          label="Wait for which agent?"
          withSelf={false}
          onPick={(target) => {
            close();
            if (target.id === undefined) return;
            // All of its work, until one of its steps is picked (beside).
            const id = crypto.randomUUID();
            onAdd({ id, waitFor: [{ agent: target.id }] });
            context.onChooseStep?.({ waitId: id, index: 0, agent: target.id });
          }}
          onCancel={close}
        />
      )}
      {step === 'wait' && !context.onChooseStep && (
        <WaitPicker
          context={context}
          onPick={(target) => {
            onAdd({ waitFor: [target] });
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'delay' && (
        <TimePicker
          label="Wait how long?"
          usage={context.usage}
          catalog={context.catalog}
          onPick={(time) => {
            if (time) onAdd({ delay: time });
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'ok' && (
        <OkPicker
          onPick={(approve) => {
            onAdd({ approve });
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'message' && (
        <TextPrompt
          label="New message to the agent"
          multiline
          onSubmit={(message) => {
            onAdd({ message, ...(target === undefined ? {} : { target }) });
            close();
          }}
          onCancel={close}
        />
      )}
      {typeof step === 'object' && (
        <TargetPicker
          context={context}
          onPick={(target) => {
            onAdd({ action: step.name, ...(target.id === undefined ? {} : { target: target.id }) });
            close();
          }}
          onCancel={close}
        />
      )}
    </div>
  );
}

/** The conditions a dropdown offers: an if-then's, or (`until`) a repeat's. */
const CONDITION_CHOICES: Readonly<
  Record<
    'if' | 'until',
    readonly { kind: 'succeeded' | 'failed' | 'outputContains' | 'timedOut'; label: string }[]
  >
> = { if: CONDITIONS, until: UNTIL_CONDITIONS };

/** A repeat another can go round with: its agent's name, and where it is. */
interface Leader {
  name: string;
  until: RepeatEnds;
}

/**
 * The other agents' repeats a repeat (`self`, undefined for a new one) can go round with: first
 * those it waits on (a wait in it waits for the repeat, or for an item in it), then the rest; none
 * that goes round with it already (two repeats would wait on each other).
 */
function leaderOptions(context: AddContext, self: QueueRepeat | undefined): Leader[] {
  const leaders = context.others.flatMap((agent) =>
    (agent.data.queue ?? []).flatMap((item): (Leader & { repeat: QueueRepeat })[] => {
      if (!isRepeat(item)) return [];
      const { until } = item;
      const follows =
        self !== undefined &&
        isRepeatEnds(until) &&
        until.agent === context.owner &&
        until.item === self.id;
      return follows
        ? []
        : [
            {
              name: nameOf(agent),
              until: { kind: 'repeatEnds', agent: agent.id, item: item.id },
              repeat: item,
            },
          ];
    }),
  );
  const waitedOn = ({ until, repeat }: { until: RepeatEnds; repeat: QueueRepeat }) =>
    self?.repeat.some(
      (inner) =>
        isWait(inner) &&
        inner.waitFor.some(
          (target) =>
            target.agent === until.agent &&
            (target.item === repeat.id || repeat.repeat.some((q) => q.id === target.item)),
        ),
    ) ?? false;
  return [...leaders.filter(waitedOn), ...leaders.filter((leader) => !waitedOn(leader))].map(
    ({ name, until }) => ({ name, until }),
  );
}

/**
 * What a condition dropdown offers: a condition, one that needs text to look for, one on usage
 * (which needs a share and a window), or a leader.
 */
interface ConditionChoice {
  label: string;
  detail?: string;
  pick: Condition | RepeatEnds | 'text' | 'usage';
}

/** The shares a usage condition offers before anything is typed. */
const USAGE_PERCENTS = [50, 70, 80, 90, 95];

/** A usage condition's share and window, as its picker offers them. */
interface UsageChoice {
  percent: number;
  window: UsageWindow;
}

/**
 * Picks the share and window of a usage condition by typing: "85" offers 85% of each window. With
 * `current`, its share is typed in to start from.
 */
function UsagePicker({
  backend,
  catalog,
  current,
  onPick,
  onCancel,
}: {
  backend: UsageBackendId;
  /** What names the backend. */
  catalog: EngineCatalog;
  current?: UsageChoice | undefined;
  onPick: (choice: UsageChoice) => void;
  onCancel: () => void;
}) {
  const choice = (percent: number, window: UsageWindow): UsageChoice => ({ percent, window });
  const options = USAGE_WINDOWS.flatMap((window) =>
    USAGE_PERCENTS.map((percent) => choice(percent, window)),
  );
  return (
    <SearchPicker
      label={`${catalog.backendName(backend)}’s usage is over…`}
      placeholder="80%, 90% weekly…"
      options={options}
      optionLabel={({ percent, window }) => `Over ${String(percent)}% of the ${windowText(window)}`}
      optionKey={({ percent, window }) => `${window}:${String(percent)}`}
      typed={(query) => {
        const percent = Number(/\d+/.exec(query)?.[0]);
        if (!Number.isInteger(percent) || percent < 1 || percent > 99) return [];
        const weekly = /week/i.test(query);
        const windows: UsageWindow[] = weekly ? ['weekly'] : ['fiveHour', 'weekly'];
        return windows.map((window) => choice(percent, window));
      }}
      {...(current ? { initialQuery: `${String(current.percent)}%` } : {})}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/**
 * Picks a condition, then the text to look for if it needs one. Or takes what was typed as the
 * condition, in the user's own words; changing such a condition starts from them. An if-then's
 * (`mode` 'if'), or when a repeat stops ('until'), which offers no timedOut but the other agents'
 * repeats it can go round with (`leaders`).
 */
function ConditionPicker({
  mode = 'if',
  current,
  leaders = [],
  usage,
  catalog,
  onPick,
  onCancel,
}: {
  mode?: 'if' | 'until';
  current?: Condition | RepeatEnds;
  leaders?: readonly Leader[];
  /** A backend whose usage an if-then can check (the agent's). */
  usage?: UsageBackendId | undefined;
  /** What names a usage backend. */
  catalog: EngineCatalog;
  onPick: (condition: Condition | RepeatEnds) => void;
  onCancel: () => void;
}) {
  const [needs, setNeeds] = useState<'kind' | 'text' | 'usage'>('kind');
  const backend = current?.kind === 'usageAbove' ? current.backend : usage;
  if (needs === 'usage' && backend !== undefined) {
    return (
      <UsagePicker
        backend={backend}
        catalog={catalog}
        current={current?.kind === 'usageAbove' ? current : undefined}
        onPick={({ percent, window }) => {
          onPick({ kind: 'usageAbove', backend, window, percent });
        }}
        onCancel={onCancel}
      />
    );
  }
  if (needs === 'text') {
    return (
      <TextPrompt
        label="Text to look for"
        onSubmit={(text) => {
          onPick({ kind: 'outputContains', text });
        }}
        onCancel={onCancel}
      />
    );
  }
  const choices: ConditionChoice[] = [
    ...CONDITION_CHOICES[mode].map((c): ConditionChoice => ({
      label: c.label,
      pick: c.kind === 'outputContains' ? 'text' : { kind: c.kind },
    })),
    ...(mode === 'if' && backend !== undefined
      ? [
          {
            label: `${catalog.backendName(backend)}’s usage is over…`,
            detail: 'By its latest reading, when the run gets here',
            pick: 'usage' as const,
          },
        ]
      : []),
    ...leaders.map(({ name, until }) => ({
      label: `${name}'s repeat ends`,
      detail: `Go round with it: as many rounds as ${name}'s repeat`,
      pick: until,
    })),
  ];
  return (
    <SearchPicker
      label={mode === 'if' ? 'If…' : 'Repeat until…'}
      placeholder={
        mode === 'if' ? 'Pick a condition, or describe one…' : 'Pick when to stop, or describe it…'
      }
      options={choices}
      optionLabel={(c) => c.label}
      optionDetail={(c) => c.detail}
      optionKey={(c) => JSON.stringify(c.pick)}
      {...(current?.kind === 'freeText' ? { initialQuery: current.text } : {})}
      freeText={{
        detail: 'In your own words, for the agent to judge',
        onPick: (text) => {
          onPick({ kind: 'freeText', text });
        },
      }}
      onPick={(c) => {
        if (c.pick === 'text' || c.pick === 'usage') setNeeds(c.pick);
        else onPick(c.pick);
      }}
      onCancel={onCancel}
    />
  );
}

/** How many rounds a new repeat runs at most. */
const DEFAULT_ROUNDS = 3;

/** Every number of rounds a repeat may run at most: 1 to MAX_ROUNDS. */
const ROUNDS = Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1);

/** Picks how many rounds a repeat runs at most, by typing: "5" finds 5 rounds. */
function RoundsPicker({
  onPick,
  onCancel,
}: {
  onPick: (rounds: number) => void;
  onCancel: () => void;
}) {
  return (
    <SearchPicker
      label="How many rounds at most?"
      placeholder="3, 5, 10…"
      options={ROUNDS}
      optionLabel={(n) => `${String(n)} round${n === 1 ? '' : 's'}`}
      optionKey={String}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/** What a repeat can do after its last round, if its condition still does not hold. */
const OTHERWISE = [
  { otherwise: 'ask', label: 'Ask me', detail: 'Stop and ask: one more round, or go on' },
  {
    otherwise: 'goOn',
    label: 'Go on',
    detail: 'Carry on with the queue; an If after it sees that it failed',
  },
] as const;

/** Picks what a repeat does after its last round: ask the user, or go on (having failed). */
function OtherwisePicker({
  onPick,
  onCancel,
}: {
  onPick: (otherwise: QueueRepeat['otherwise']) => void;
  onCancel: () => void;
}) {
  return (
    <SearchPicker
      label="After the last round…"
      options={OTHERWISE}
      optionLabel={(option) => option.label}
      optionDetail={(option) => option.detail}
      optionKey={(option) => option.otherwise}
      onPick={(option) => {
        onPick(option.otherwise);
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * A repeat: "Repeat until <condition>", how many rounds at most and what then (each a chip that
 * changes it), and under it, indented on a rail that ends in ↺, the steps, messages, waits and
 * delays it runs each round, with its own ⊕. One that goes round with another agent's repeat shows
 * neither rounds nor then (it runs as many as that one); one that others go round with names them
 * at its foot. While the run is in it, a pill says which round (`data-round`); once it is out of
 * rounds and asks the user, how to decide shows under its header, without pointing at it. While a
 * wait's target is picked from its queue, each item it holds picks, and its header the repeat.
 */
function RepeatRow({
  item,
  handle,
  context,
  onMove,
  onAdd,
  onRepeat,
}: {
  item: QueueRepeat;
  handle: HandleProps;
  context: Context;
  onMove: (itemId: string, index: number) => void;
  onAdd: (entry: QueueEntry) => void;
  onRepeat: (change: RepeatChange) => void;
}) {
  const [editing, setEditing] = useState<'until' | 'rounds' | 'otherwise'>();
  const marks = context.marks(item.id);
  const text = context.untilText(item.until);
  const rounds = roundsText(item.rounds);
  const then = otherwiseText(item);
  /** It goes round with another: as many rounds as that one, so its own are not shown. */
  const follows = isRepeatEnds(item.until);
  const { rowOf, picking } = context;
  /** Inside it, a wait waits round by round. */
  const inside = { ...context, inRepeat: true };
  /** The other agents' repeats that go round with it. */
  const followers = context.others.filter((agent) =>
    (agent.data.queue ?? []).some(
      (q) =>
        isRepeat(q) &&
        isRepeatEnds(q.until) &&
        q.until.agent === context.owner &&
        q.until.item === item.id,
    ),
  );
  const pick = (picked: QueueItem) =>
    picking && (
      <PickTask
        label={`Wait for ${picking.name}: ${context.itemLabel(picked)}`}
        pressed={picking.current === picked.id}
        onPick={() => {
          picking.onPick(picked.id);
        }}
      />
    );
  const close = () => {
    setEditing(undefined);
  };
  const chip = (which: 'until' | 'rounds' | 'otherwise', label: string, shown: string) => (
    <button
      type="button"
      className="graph-queue-target"
      aria-label={label}
      aria-expanded={editing === which}
      onClick={() => {
        setEditing(editing === which ? undefined : which);
      }}
    >
      {shown}
    </button>
  );
  return (
    <div className="graph-queue-repeat" {...marks}>
      <div className="graph-queue-row graph-queue-repeat-head">
        <Handle handle={handle} item={item} context={context} />
        <span className="graph-queue-keyword">Repeat until</span>
        {chip('until', `Change when it stops: ${text}`, text)}
        {!follows && chip('rounds', `Change how many rounds: ${rounds}`, rounds)}
        {!follows && chip('otherwise', `Change what happens after the last round: ${then}`, then)}
        <RemoveButton item={item} context={context} />
        {marks['data-decide'] !== undefined && (
          <DecideBar
            item={item}
            problem={problemOf(marks)}
            onDecide={(answer) => {
              context.onDecide(item.id, answer);
            }}
          />
        )}
        {editing === 'until' && (
          <ConditionPicker
            mode="until"
            current={item.until}
            leaders={leaderOptions(context, item)}
            catalog={context.catalog}
            onPick={(until) => {
              if (until.kind !== 'timedOut' && until.kind !== 'usageAbove') onRepeat({ until });
              close();
            }}
            onCancel={close}
          />
        )}
        {editing === 'rounds' && (
          <RoundsPicker
            onPick={(n) => {
              onRepeat({ rounds: n });
              close();
            }}
            onCancel={close}
          />
        )}
        {editing === 'otherwise' && (
          <OtherwisePicker
            onPick={(otherwise) => {
              onRepeat({ otherwise });
              close();
            }}
            onCancel={close}
          />
        )}
        {pick(item)}
        <TaskResult item={item} context={context} controls={false} />
      </div>
      {item.repeat.length > 0 && (
        <SortableList
          items={item.repeat}
          className="graph-queue graph-queue-then graph-queue-rounds"
          label={`Each round: ${text}`}
          onMove={onMove}
          {...(rowOf ? { rowOf: (inner: RepeatedItem) => rowOf(inner.id) } : {})}
          renderItem={(inner, innerHandle) => (
            <>
              <RepeatedRow item={inner} handle={innerHandle} context={inside} />
              {pick(inner)}
            </>
          )}
        />
      )}
      {followers.length > 0 && (
        <p className="graph-queue-repeat-foot">
          {andList(followers.map(nameOf))} go{followers.length === 1 ? 'es' : ''} round with it
        </p>
      )}
      <AddMenu
        label={`Add to ${context.describe(item)}`}
        place="repeat"
        context={context}
        onAdd={onAdd}
      />
    </div>
  );
}
