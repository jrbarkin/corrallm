import { JOBS } from '../adapter';
import type { Job } from '../adapter';
import { CANVAS_VERSION } from '../canvas';
import type { CanvasDocument, FrameNode, AgentNode } from './canvas';
import { fromFile } from './file';
import type {
  QueueApproval,
  QueueDelay,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueWait,
} from './queue';

/** Shipped-template work; it becomes a native action only after its recipient is chosen. */
export interface TemplateStep {
  id: string;
  job: Job;
  instruction?: string;
  expect?: 'fails';
  target?: string;
}
export type TemplateRepeated = TemplateStep | QueueMessage | QueueWait | QueueDelay;
export type TemplateItem =
  | TemplateRepeated
  | QueueApproval
  | (Omit<QueueIf, 'then'> & { then: (TemplateStep | QueueMessage)[] })
  | (Omit<QueueRepeat, 'repeat'> & { repeat: TemplateRepeated[] });
export type TemplateNode =
  | FrameNode
  | (Omit<AgentNode, 'data'> & {
      data: Pick<AgentNode['data'], 'label' | 'role' | 'color'> & { queue?: TemplateItem[] };
    });
export interface TemplateDocument extends Omit<CanvasDocument, 'nodes'> {
  nodes: TemplateNode[];
}

/** A separate, strict reader for shipped definitions, never for files a user opens. */
export function readTemplate(text: string): TemplateDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This is not a corrallm template');
  }
  const file = record(value, 'template');
  if (file.format !== 'corrallm-template') throw new Error('This is not a corrallm template');
  if (file.version !== 1) throw new Error('template.version must be 1');
  keys(file, ['format', 'version', 'id', 'arrange', 'nodes', 'links'], 'template');
  if (!Array.isArray(file.nodes)) throw new Error('nodes must be an array');
  const nodes = file.nodes.map((value: unknown, i: number) => {
    const at = `nodes[${String(i)}]`;
    const node = record(value, at);
    keys(node, ['id', 'kind', 'label', 'position', 'parent', 'role', 'color', 'queue'], at);
    return {
      ...node,
      ...(node.queue === undefined ? {} : { queue: prepareQueue(node.queue, `${at}.queue`) }),
    };
  });
  // Reuse the canvas's structural and text validation on a private intermediate, with no catalog.
  // No job escapes this reader into a runtime document.
  const checked = fromFile(
    JSON.stringify({ ...file, format: 'corrallm', version: CANVAS_VERSION, nodes }),
    { adapters: [], usageBackends: [] },
  );
  return {
    ...checked,
    nodes: checked.nodes.map((node) =>
      node.type === 'frame'
        ? node
        : {
            ...node,
            data: {
              label: node.data.label,
              ...(node.data.role === undefined ? {} : { role: node.data.role }),
              ...(node.data.color === undefined ? {} : { color: node.data.color }),
              ...(node.data.queue === undefined
                ? {}
                : { queue: node.data.queue.map(asTemplateItem) }),
            },
          },
    ),
  };
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${where}.${key} is not a template field`);
}
function prepareQueue(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value.map((value: unknown, i: number): Record<string, unknown> => {
    const at = `${where}[${String(i)}]`;
    const item = record(value, at);
    if ('action' in item) throw new Error(`${at}.action is not a template field; use job`);
    const kinds = ['job', 'message', 'then', 'repeat', 'waitFor', 'delay', 'approve'].filter(
      (key) => key in item,
    );
    if (kinds.length !== 1) throw new Error(`${at} must hold exactly one kind of template item`);
    if ('job' in item) {
      keys(item, ['id', 'job', 'instruction', 'expect', 'target'], at);
      if (!JOBS.some((job) => job === item.job))
        throw new Error(`${at}.job must name a catalog job`);
      const { job, ...rest } = item;
      return { ...rest, action: job };
    }
    if ('then' in item) {
      keys(item, ['id', 'by', 'if', 'then'], at);
      return { ...item, then: prepareQueue(item.then, `${at}.then`) };
    }
    if ('repeat' in item) {
      keys(item, ['id', 'by', 'repeat', 'until', 'rounds', 'otherwise'], at);
      return { ...item, repeat: prepareQueue(item.repeat, `${at}.repeat`) };
    }
    keys(
      item,
      'message' in item
        ? ['id', 'by', 'message', 'target']
        : 'waitFor' in item
          ? ['id', 'by', 'waitFor', 'timeout']
          : 'delay' in item
            ? ['id', 'by', 'delay']
            : ['id', 'by', 'approve'],
      at,
    );
    return item;
  });
}
function asTemplateItem(item: QueueItem): TemplateItem {
  if ('then' in item) return { ...item, then: item.then.map(asTemplateStep) };
  if ('repeat' in item) return { ...item, repeat: item.repeat.map(asTemplateStep) };
  return asTemplateStep(item);
}
function asTemplateStep<T extends Exclude<QueueItem, QueueIf | QueueRepeat>>(
  item: T,
): Exclude<T, { action: string }> | TemplateStep {
  if (!('action' in item)) return item as Exclude<T, { action: string }>;
  const { action, ...rest } = item;
  return { ...rest, job: action as Job };
}
