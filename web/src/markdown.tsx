/** A small Markdown renderer for model answers: paragraphs, headings, lists, bold, code, links and [n] citations. Italics render as plain text. */
import type { ReactNode } from 'react';

export interface MarkdownProps {
  text: string;
  onCitation?(n: number): void;
  /** Hover with the pill's position, so a preview can be anchored to it. */
  onCitationHover?(n: number | null, rect?: DOMRect): void;
  hot?: number | null;
}

export function Markdown({ text, onCitation, onCitationHover, hot }: MarkdownProps) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case 'heading':
            return <h3 key={key}>{inline(block.text, { onCitation, onCitationHover, hot })}</h3>;
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item, { onCitation, onCitationHover, hot })}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} start={block.start}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item, { onCitation, onCitationHover, hot })}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={key}>{inline(block.text, { onCitation, onCitationHover, hot })}</blockquote>;
          default:
            return <p key={key}>{inline(block.text, { onCitation, onCitationHover, hot })}</p>;
        }
      })}
    </>
  );
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[]; start: number };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', text: heading[1]! });
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flush();
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') });
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ul') last.items.push(bullet[1]!);
      else blocks.push({ type: 'ul', items: [bullet[1]!] });
      continue;
    }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ol') last.items.push(numbered[2]!);
      else blocks.push({ type: 'ol', items: [numbered[2]!], start: Number(numbered[1]) });
      continue;
    }
    // Continuation of a list item (indented line).
    const last = blocks[blocks.length - 1];
    if (/^\s{2,}/.test(line) && last && (last.type === 'ul' || last.type === 'ol') && paragraph.length === 0) {
      last.items[last.items.length - 1] += ' ' + trimmed;
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

interface InlineOptions {
  onCitation?(n: number): void;
  onCitationHover?(n: number | null, rect?: DOMRect): void;
  hot?: number | null;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[(?:\d+)(?:\]\[\d+)*\]|\[\d+(?:,\s*\d+)+\]|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\)|https?:\/\/[^\s)]+)/g;

function inline(text: string, options: InlineOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key++}>{inline(token.slice(2, -2), options)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if ((token.startsWith('*') || token.startsWith('_')) && token.length > 2) nodes.push(...inline(token.slice(1, -1), options).map((node) => (typeof node === 'string' ? node : <span key={key++}>{node}</span>)));
    else if (/^\[\d/.test(token)) {
      const numbers = token.match(/\d+/g)?.map(Number) ?? [];
      numbers.forEach((n) => {
        nodes.push(
          <button
            key={key++}
            type="button"
            className={`cite${options.hot === n ? ' hot' : ''}`}
            aria-label={`Source ${n}`}
            onClick={() => options.onCitation?.(n)}
            onMouseEnter={(event) => options.onCitationHover?.(n, event.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => options.onCitationHover?.(null)}
          >
            {n}
          </button>,
        );
      });
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) nodes.push(<a key={key++} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      else nodes.push(token);
    } else nodes.push(<a key={key++} href={token} target="_blank" rel="noreferrer">{token.replace(/^https?:\/\//, '').slice(0, 60)}</a>);
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
