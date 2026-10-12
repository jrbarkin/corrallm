import type { ReactNode } from 'react';

/**
 * The little Markdown agents write in replies: paragraphs, "- " and "1. " lists, **bold**,
 * _italic_ and `code`.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((line) => line.startsWith('- '))) {
          return (
            <ul key={i}>
              {lines.map((line, j) => (
                <li key={j}>{inline(line.slice(2))}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((line) => /^\d+\. /.test(line))) {
          return (
            <ol key={i}>
              {lines.map((line, j) => (
                <li key={j}>{inline(line.replace(/^\d+\. /, ''))}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{inline(block)}</p>;
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
