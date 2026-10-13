import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';

import { SearchPicker } from '../search/SearchPicker';
import type { AgentAction, AgentType } from './agents';
import type { GraphNode } from './graph';
import { agentName, andList, ifText, itemLabel, waitTargetLabel } from './labels';
import { CONDITIONS, isIf, isMessage, isWait, sameTarget } from './queue';
import type {
  Condition,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueStep,
  QueueWait,
  WaitTarget,
} from './queue';
import { SortableList } from './SortableList';
import type { HandleProps } from './SortableList';
import '../run/run.css';

const EMPTY: readonly QueueItem[] = [];

/** A queue item, before it is added: its id is made then, unless it brings one. */
export type QueueEntry = (
  Omit<QueueStep, 'id'> | Omit<QueueMessage, 'id'> | Omit<QueueIf, 'id'> | Omit<QueueWait, 'id'>
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
  /** `into`: the id of the if-then to add a step or message to. */
  onAdd: (entry: QueueEntry, into?: string) => void;
  onRemove: (itemId: string) => void;
  onMove: (itemId: string, index: number) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
  onCondition: (ifId: string, condition: Condition) => void;
  onWaitFor: (waitId: string, targets: WaitTarget[]) => void;
  /**
   * Once an agent is picked for a wait, lets the user pick one of its steps (AgentView shows its
   * queue beside). Without it, the wait picker lists their steps too.
   */
  onChooseStep?: (choice: StepChoice) => void;
  /** The wait target being picked, to show which. */
  choosing?: Omit<StepChoice, 'agent'>;
  /** Marks for the row of each item and if-then step, by id, and (null) the queue's end. */
  marks?: (itemId: string | null) => RowMarks;
}

/**
 * An agent's queue, in order: steps (one of the agent's actions, done to an agent: this one unless
 * another is picked), messages (text passed to an agent), if-thens (steps and messages that run
 * only when a condition holds), and waits (until other agents have finished). The ⊕ adds any of them; everything is picked by typing to
 * search. Rows are reordered by dragging their handle, or with the arrow keys on it. With `only`,
 * it shows part of the queue (WorkDetail.tsx), where reordering moves items among those shown.
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
          <AddMenu label={addLabel} withIf context={context} onAdd={onAdd} />
        </>
      )}
      {typeof add === 'object' && (
        <AddMenu
          label={`Queue work for ${context.name(add.workFor)}`}
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

/** An item's row: a step, a message, a wait, or an if-then with its own steps. */
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
  const row = (step: QueueStep | QueueMessage, stepHandle: HandleProps) =>
    isMessage(step) ? (
      <MessageRow item={step} handle={stepHandle} context={context} />
    ) : (
      <StepRow item={step} handle={stepHandle} context={context} />
    );
  if (isWait(item)) return <WaitRow item={item} handle={handle} context={context} />;
  if (!isIf(item)) return row(item, handle);
  return (
    <IfRow
      item={item}
      handle={handle}
      context={context}
      row={row}
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
  onChooseStep,
  choosing,
  marks,
}: QueueProps): Context {
  const others = nodes.filter((n) => n.type === 'agent' && n.id !== node.id);
  const name = (id: string | undefined) => (id === undefined ? 'this agent' : agentName(nodes, id));
  const targetLabel = (target: WaitTarget) => waitTargetLabel(nodes, target);
  const describe = (item: QueueItem) =>
    isWait(item)
      ? `Wait for ${andList(item.waitFor.map(targetLabel))}`
      : isIf(item)
        ? `If ${ifText(item.if)}`
        : isMessage(item)
          ? 'Message'
          : item.action;
  return {
    agent,
    actions,
    others,
    name,
    ifText,
    itemLabel,
    targetLabel,
    describe,
    onRemove,
    onRetarget,
    onEditMessage,
    onWaitFor,
    marks: marks ?? (() => ({})),
    ...(onChooseStep ? { onChooseStep } : {}),
    ...(choosing ? { choosing } : {}),
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
  targetLabel: (target: WaitTarget) => string;
  describe: (item: QueueItem) => string;
  onRemove: (itemId: string) => void;
  onRetarget: (itemId: string, target: string | undefined) => void;
  onEditMessage: (itemId: string, message: string) => void;
  onWaitFor: (waitId: string, targets: WaitTarget[]) => void;
  choosing?: Omit<StepChoice, 'agent'>;
  marks: (itemId: string) => RowMarks;
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
  return <AddMenu label={label} withIf up={up} context={context} onAdd={onAdd} />;
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
      detail: 'Just this step',
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
 * off (but the last), and a button that adds another. With `onChooseStep`, a target's chip picks
 * its step again, and an added target's agent is picked first, then its step.
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
      <RemoveButton item={item} context={context} />
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

/** An if-then: "If <condition> then" (the condition a chip that changes it), and its steps. */
function IfRow({
  item,
  handle,
  context,
  row,
  onMove,
  onAdd,
  onCondition,
}: {
  item: QueueIf;
  handle: HandleProps;
  context: Context;
  row: (item: QueueStep | QueueMessage, handle: HandleProps) => ReactNode;
  onMove: (itemId: string, index: number) => void;
  onAdd: (entry: QueueEntry) => void;
  onCondition: (condition: Condition) => void;
}) {
  const [editing, setEditing] = useState(false);
  const text = context.ifText(item.if);
  return (
    <div className="graph-queue-if" {...context.marks(item.id)}>
      <div className="graph-queue-row">
        <Handle handle={handle} item={item} context={context} />
        <span className="graph-queue-keyword">If</span>
        <button
          type="button"
          className="graph-queue-target"
          aria-label={`Change the condition: ${text}`}
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
          renderItem={row}
        />
      )}
      <AddMenu label={`Add to If ${text}`} context={context} onAdd={onAdd} />
    </div>
  );
}

type Choice =
  { kind: 'if' } | { kind: 'wait' } | { kind: 'message' } | { kind: 'action'; action: AgentAction };

const CHOICE_TEXT = {
  if: ['If… then', 'Run steps only when a condition holds'],
  wait: ['Wait for…', 'Go on only once other agents have finished'],
  message: ['Message', 'Tell an agent something'],
} as const;

/**
 * The ⊕ and its dropdowns: one of the agent's actions, a message, or (`withIf`, for the queue
 * itself) "If… then" and "Wait for…"; then the agent the action acts on (unless `target` fixes it),
 * the message's text, the if-then's condition, or the agent to wait for.
 */
function AddMenu({
  label,
  withIf = false,
  up = false,
  target,
  context,
  onAdd,
}: {
  label: string;
  withIf?: boolean;
  /** Whether its menus open above it, for a ⊕ at the bottom of the view. */
  up?: boolean;
  /** The agent every action and message added is aimed at; by default, the queue's own. */
  target?: string;
  context: AddContext;
  onAdd: (entry: QueueEntry) => void;
}) {
  const [step, setStep] = useState<
    'closed' | 'choose' | 'condition' | 'wait' | 'message' | AgentAction
  >('closed');
  const close = () => {
    setStep('closed');
  };
  const choices: Choice[] = [
    ...(withIf ? [{ kind: 'if' as const }, { kind: 'wait' as const }] : []),
    { kind: 'message' },
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

/**
 * Picks a condition, then the text to look for if it needs one. Or takes what was typed as the
 * condition, in the user's own words; changing such a condition starts from them.
 */
function ConditionPicker({
  current,
  onPick,
  onCancel,
}: {
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
      label="If…"
      placeholder="Pick a condition, or describe one…"
      options={CONDITIONS}
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
