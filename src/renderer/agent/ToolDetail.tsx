import type { ToolDetail } from '../../shared/session';

/**
 * What a tool call shows when opened (an edit's diff, or a command's output): in the transcript
 * (Transcript.tsx), and in what a Terminal agent's CLI asks, listed in Needs you
 * (graph/Questions.tsx).
 */
export function ToolDetailView({
  detail,
  verbatim = false,
}: {
  detail: ToolDetail;
  /** A unified patch already carries its line prefixes. */
  verbatim?: boolean;
}) {
  if (detail.kind === 'output') return <pre className="agent-tool-detail">{detail.text}</pre>;
  return (
    <pre className="agent-tool-detail agent-diff-lines">
      {detail.lines.map((line, i) => (
        <span key={i} data-line={line.kind}>
          {!verbatim && (line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  ')}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
