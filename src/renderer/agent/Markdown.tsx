import type { ReactNode } from 'react';

import { parseInline, parseMarkdown } from './blocks';
import type { Block, Inline } from './blocks';

/**
 * Markdown as agents write it in replies (markdown.ts): paragraphs, headings, code blocks, quotes,
 * lists, tables, rules; and inline code, bold, italic, struck-out text and links. Links open in
 * the browser only where the app allows it (security.ts).
 */
export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map((block, i) => renderBlock(block, i))}</>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.text)}</p>;
    case 'heading': {
      const Heading = (['h3', 'h4', 'h5', 'h5', 'h6', 'h6'] as const)[block.level - 1] ?? 'h6';
      return (
        <Heading key={key} className="agent-md-heading">
          {renderInline(block.text)}
        </Heading>
      );
    }
    case 'code':
      return (
        <pre key={key} className="agent-md-code" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key}>{block.blocks.map((inner, i) => renderBlock(inner, i))}</blockquote>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          {/* A one-line item reads as a line, not a paragraph. */}
          {item.length === 1 && item[0]?.kind === 'paragraph'
            ? renderInline(item[0].text)
            : item.map((inner, j) => renderBlock(inner, j))}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div key={key} className="agent-md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={{ textAlign: block.align[j] }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr key={key} />;
  }
}

function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((part, i) => inline(part, i));
}

function inline(part: Inline, key: number): ReactNode {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'break':
      return <br key={key} />;
    case 'code':
      return <code key={key}>{part.text}</code>;
    case 'strong':
      return <strong key={key}>{part.children.map(inline)}</strong>;
    case 'em':
      return <em key={key}>{part.children.map(inline)}</em>;
    case 'strike':
      return <s key={key}>{part.children.map(inline)}</s>;
    case 'link':
      return /^https?:\/\//.test(part.href) ? (
        <a key={key} href={part.href} title={part.href} target="_blank" rel="noreferrer">
          {part.children.map(inline)}
        </a>
      ) : (
        <span key={key} title={part.href}>
          {part.children.map(inline)}
        </span>
      );
  }
}
