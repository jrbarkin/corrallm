import type { CanvasId } from '../../shared/canvas';
import type { ArgsOf, ResultOf } from '../../shared/api/registry';
import { AgentId } from '../../shared/api/ids';
import type { TopicMirror } from '../api/topics';
import { useSessionView } from '../api/runtime';
import { PromptCard } from './PromptCard';

interface Props {
  item: ResultOf<'needs'>['items'][number];
  mirror: TopicMirror;
  onReply: (answer: ArgsOf<'reply'>['answer']) => Promise<unknown>;
  onOpen: (agent: string) => void;
}
/** Needs and queues read the same whole occurrence the agent window renders, with no local copy. */
export function OwnedPrompt(props: Props) {
  return props.item.agent ? <WholePrompt {...props} agent={props.item.agent} /> : null;
}
function WholePrompt({ item, mirror, onReply, onOpen, agent }: Props & { agent: string }) {
  const view = useSessionView(item.canvas as CanvasId, AgentId.parse(agent), mirror);
  const entry = item.prompt?.id ? view?.entries[item.prompt.id] : undefined;
  if (entry?.kind === 'prompt' && entry.need === item.id)
    return (
      <PromptCard
        entry={entry}
        onReply={onReply}
        onOpenTerminal={() => {
          onOpen(agent);
        }}
      />
    );
  return (
    <div role="group" aria-label={item.title}>
      <p>{item.title}</p>
      {item.detail && <pre>{item.detail}</pre>}
      <p>Loading the complete prompt…</p>
      {item.choices.map((choice) => (
        <button type="button" key={choice.value} disabled>
          {choice.label}
        </button>
      ))}
      {item.answerIn === 'terminal' && (
        <button
          type="button"
          onClick={() => {
            onOpen(agent);
          }}
        >
          Open terminal
        </button>
      )}
    </div>
  );
}
