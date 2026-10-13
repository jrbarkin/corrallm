import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import { threadTitle } from '../agent/session';
import { answersOf } from '../run/asks';
import type { Answer } from '../run/runner';
import { SearchPicker } from '../search/SearchPicker';
import type { AgentAction, AgentType } from './agents';
import type { GraphNode } from './graph';
import type { RepeatChange } from './edits';
import {
  agentName,
  describe,
  ifText,
  itemLabel,
  okWhat,
  otherwiseText,
  roundsText,
  untilText,
  waitTargetLabel,
} from './labels';
import {
  CONDITIONS,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isWait,
  MAX_ROUNDS,
  sameTarget,
  unfit,
  UNTIL_CONDITIONS,
} from './queue';
import type {
  Condition,
  QueueApproval,
  QueueDelay,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  QueueWait,
  RepeatedItem,
  Time,
  Until,
  WaitTarget,
} from './queue';
import { leftText, limitText, parseTime, TIME_PRESETS, timeText } from './time';
import { SortableList } from './SortableList';
import type { HandleProps } from './SortableList';
import '../run/run.css';

const EMPTY: readonly QueueItem[] = [];

/** A queue item, before it is added: its id is made then, unless it brings one. */
export type QueueEntry = (
  | Omit<QueueStep, 'id'>
  | Omit<QueueMessage, 'id'>
  | Omit<QueueIf, 'id'>
  | Omit<QueueWait, 'id'>
  | Omit<QueueDelay, 'id'>
  | Omit<QueueApproval, 'id'>
  | Omit<QueueRepeat, 'id'>
) & { id?: string };

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

const nameOf = (node: GraphNode | undefined) =>
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
  node: GraphNode;
  /** Every node of the graph: the agents steps can act on, and their names. */
  nodes: readonly GraphNode[];
  agent: AgentType;
  /** What the agent can do. */
  actions: readonly AgentAction[];
  /** `into`: the id of the if-then or repeat to add to. */
  onAdd: (entry: QueueEntry, into?: string) => void;
  onRemove: (itemId: string) => void;
  onMove: (itemId: string, index: number) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
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
  picking,
  ...props
}: QueueProps & {
  /** The name of the ⊕ that adds anything. */
  addLabel?: string;
  /** While a wait's target is picked from this queue: each item, and its end, picks. */
  picking?: Picking | undefined;
  /** Shows only the items for which this holds (an if-then whole, with all of its steps). */
  only?: (item: QueueItem) => boolean;
  /**
   * What ⊕ adds: anything (the default), nothing (no ⊕), or (`workFor`, an agent's id) one of the
   * agent's actions, aimed at that agent.
   */
  add?: 'anything' | 'nothing' | { workFor: string };
}) {
  const { node, onAdd, onMove } = props;
  const queue = node.data.queue ?? EMPTY;
  const context = contextOf(props);
  const shown = only ? queue.filter(only) : queue;
  /** Moves an item to `index` among those shown: to where the item now there is in the queue. */
  const moveShown = (itemId: string, index: number) => {
    const at = shown[Math.min(Math.max(index, 0), shown.length - 1)];
    if (at) onMove(itemId, queue.indexOf(at));
  };

  return (
    <>
      {shown.length > 0 && (
        <SortableList
          items={shown}
          className="graph-queue"
          onMove={moveShown}
          renderItem={(item, handle) => (
            <>
              <ItemRow item={item} handle={handle} context={context} props={props} />
              {picking && (
                <PickTask
                  label={`Wait for ${picking.name}: ${itemLabel(item)}`}
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
  onWaitFor,
  onTime,
  onApproval,
  onGoOn,
  onDecide,
  onChooseStep,
  choosing,
  marks,
  rowOf,
}: QueueProps): Context {
  const others = nodes.filter((n) => n.type === 'agent' && n.id !== node.id);
  const name = (id: string | undefined) => (id === undefined ? 'this agent' : agentName(nodes, id));
  const targetLabel = (target: WaitTarget) => waitTargetLabel(nodes, target);
  const queue = node.data.queue ?? EMPTY;
  return {
    agent,
    actions,
    others,
    name,
    ifText,
    untilText: (until) => untilText(nodes, until),
    itemLabel,
    targetLabel,
    describe: (item) => describe(nodes, item),
    onRemove,
    onRetarget,
    onEditMessage,
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
  };
}

/** What the ⊕ and its menus need: the agent's actions, the other agents, and how items read. */
interface AddContext {
  actions: readonly AgentAction[];
  others: readonly GraphNode[];
  itemLabel: (item: QueueItem) => string;
  onChooseStep?: (choice: StepChoice) => void;
}

interface Context extends AddContext {
  agent: AgentType;
  name: (id: string | undefined) => string;
  ifText: (condition: Condition) => string;
  untilText: (until: Until) => string;
  targetLabel: (target: WaitTarget) => string;
  describe: (item: QueueItem) => string;
  onRemove: (itemId: string) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
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
  node: GraphNode;
  nodes: readonly GraphNode[];
  actions: readonly AgentAction[];
  /** Its name, telling it from the queue's own ⊕. */
  label?: string;
  up?: boolean;
  onAdd: (entry: QueueEntry) => void;
  onChooseStep?: (choice: StepChoice) => void;
}) {
  const others = nodes.filter((n) => n.type === 'agent' && n.id !== node.id);
  const context = { actions, others, itemLabel, ...(onChooseStep ? { onChooseStep } : {}) };
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
 * Picks a time by typing: a length, or a time of day (time.ts reads what is typed, and lists what
 * it can mean first), or one of the presets. With `current`, its words are typed in to start
 * from. With `allowNone`, "No time limit" comes first, which picks undefined.
 */
function TimePicker({
  label,
  current,
  allowNone = false,
  onPick,
  onCancel,
}: {
  label: string;
  current?: Time;
  allowNone?: boolean;
  onPick: (time: Time | undefined) => void;
  onCancel: () => void;
}) {
  const options: (Time | null)[] = [...(allowNone ? [null] : []), ...TIME_PRESETS];
  return (
    <SearchPicker
      label={label}
      placeholder="10 minutes, 1 hour, until 9:00…"
      options={options}
      optionLabel={(time) => (time === null ? 'No time limit' : upper(timeText(time)))}
      optionKey={(time) => (time === null ? '(none)' : JSON.stringify(time))}
      typed={parseTime}
      {...(current ? { initialQuery: timeText(current) } : {})}
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

/** A step: its handle, its action, the agent it acts on (a chip that changes it), and remove. */
function StepRow({
  item,
  handle,
  context,
}: {
  item: QueueStep;
  handle: HandleProps;
  context: Context;
}) {
  const known = context.actions.some((a) => a.name === item.action);
  return (
    <div
      className={known ? 'graph-queue-row' : 'graph-queue-row unavailable'}
      {...context.marks(item.id)}
    >
      <Handle handle={handle} item={item} context={context} />
      <span
        className="graph-queue-action"
        {...(known ? {} : { title: `${context.agent} has no ${item.action}` })}
      >
        {item.action}
      </span>{' '}
      <TargetChip item={item} label={`Change the agent ${item.action} acts on`} context={context} />
      <RemoveButton item={item} context={context} />
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
  return (
    <div className="graph-queue-row graph-queue-message" {...context.marks(item.id)}>
      <Handle handle={handle} item={item} context={context} />
      <span className="graph-queue-keyword">Message</span>
      <TargetChip item={item} label="Change the agent the message goes to" context={context} />
      <textarea
        aria-label="Message to the agent"
        placeholder="Tell the agent what to do"
        value={item.message}
        onChange={(event) => {
          context.onEditMessage(item.id, event.target.value);
        }}
      />
      <RemoveButton item={item} context={context} />
    </div>
  );
}

/** What a wait can wait for: each other agent (all of its work), then each item in its queue. */
function waitOptions(context: AddContext) {
  return context.others.flatMap((agent) => [
    { target: { agent: agent.id }, label: nameOf(agent), detail: 'All of its work' },
    ...(agent.data.queue ?? []).map((item) => ({
      target: { agent: agent.id, item: item.id },
      label: `${nameOf(agent)}: ${context.itemLabel(item)}`,
      detail: isRepeat(item) ? 'All of its rounds' : 'Just this step',
    })),
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
          aria-label={`Change the time limit: ${limitText(item.timeout)}`}
          aria-expanded={timing}
          onClick={() => {
            setTiming(!timing);
          }}
        >
          {limitText(item.timeout)}
        </button>
      )}
      <RowCountdown id={item.id} context={context} />
      <GoOn item={item} context={context} />
      <RemoveButton item={item} context={context} />
      {timing && (
        <TimePicker
          label="Go on anyway after…"
          allowNone={item.timeout !== undefined}
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
  const text = timeText(item.delay);
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
          onPick={(time) => {
            if (time) context.onTime(item.id, time);
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      )}
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
    </div>
  );
}

/**
 * How to answer at an item the run holds its queue at for the user (asks.ts answersOf): the
 * primary choice, filled; an answer in the user's own words, in a multi-line prompt (Enter sends,
 * Shift+Enter starts a new line, Esc cancels); then the other choices. Shown on the row whenever
 * the run waits for the user, never hidden. A plain div, so All queues' groups stay as they are.
 */
export function DecideBar({
  item,
  onDecide,
}: {
  item: QueueItem;
  onDecide: (answer: Answer) => void;
}) {
  const [replying, setReplying] = useState(false);
  const answers = answersOf(item);
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
        {editing && (
          <ConditionPicker
            current={item.if}
            onPick={(condition) => {
              onCondition(condition);
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
 * anywhere). file.ts rejects the rest ("an if-then cannot hold …", "a repeat cannot hold …").
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
  context,
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
          onPick={(condition) => {
            onAdd({ if: condition, then: [] });
            close();
          }}
          onCancel={close}
        />
      )}
      {step === 'until' && (
        <ConditionPicker
          mode="until"
          onPick={(until) => {
            if (until.kind !== 'timedOut') {
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

/**
 * Picks a condition, then the text to look for if it needs one. Or takes what was typed as the
 * condition, in the user's own words; changing such a condition starts from them. An if-then's
 * (`mode` 'if'), or when a repeat stops ('until'), which offers no timedOut.
 */
function ConditionPicker({
  mode = 'if',
  current,
  onPick,
  onCancel,
}: {
  mode?: 'if' | 'until';
  current?: Condition;
  onPick: (condition: Condition) => void;
  onCancel: () => void;
}) {
  const [needs, setNeeds] = useState<'kind' | 'text'>('kind');
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
  return (
    <SearchPicker
      label={mode === 'if' ? 'If…' : 'Repeat until…'}
      placeholder={
        mode === 'if' ? 'Pick a condition, or describe one…' : 'Pick when to stop, or describe it…'
      }
      options={CONDITION_CHOICES[mode]}
      optionLabel={(c) => c.label}
      optionKey={(c) => c.kind}
      {...(current?.kind === 'freeText' ? { initialQuery: current.text } : {})}
      freeText={{
        detail: 'In your own words, for the agent to judge',
        onPick: (text) => {
          onPick({ kind: 'freeText', text });
        },
      }}
      onPick={(c) => {
        if (c.kind === 'outputContains') setNeeds('text');
        else onPick({ kind: c.kind });
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
 * delays it runs each round, with its own ⊕. While the run is in it, a pill says which round
 * (`data-round`); once it is out of rounds and asks the user, how to decide shows under its header,
 * without pointing at it.
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
  const { rowOf } = context;
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
        {chip('rounds', `Change how many rounds: ${rounds}`, rounds)}
        {chip('otherwise', `Change what happens after the last round: ${then}`, then)}
        <RemoveButton item={item} context={context} />
        {marks['data-decide'] !== undefined && (
          <DecideBar
            item={item}
            onDecide={(answer) => {
              context.onDecide(item.id, answer);
            }}
          />
        )}
        {editing === 'until' && (
          <ConditionPicker
            mode="until"
            current={item.until}
            onPick={(until) => {
              if (until.kind !== 'timedOut') onRepeat({ until });
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
      </div>
      {item.repeat.length > 0 && (
        <SortableList
          items={item.repeat}
          className="graph-queue graph-queue-then graph-queue-rounds"
          label={`Each round: ${text}`}
          onMove={onMove}
          {...(rowOf ? { rowOf: (inner: RepeatedItem) => rowOf(inner.id) } : {})}
          renderItem={(inner, innerHandle) => (
            <RepeatedRow item={inner} handle={innerHandle} context={context} />
          )}
        />
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
