/** A small Markdown renderer for model answers: paragraphs, headings, lists, bold/italic/code, links and [n] citations. */
import type { ReactNode } from 'react';

interface MarkdownProps {
  text: string;
  onCitation?(n: number): void;
  /** Hover with the pill's position, so a preview can be anchored to it. */
  onCitationHover?(n: number | null, rect?: DOMRect): void;
  hot?: number | null;
  /** The kind of source behind a citation number, so its pill takes that source's line colour. */
  citeKind?(n: number): string | undefined;
}

/** Lines an answer may set apart: the downsides, what may have changed, and what to do next. */
const CALLOUTS: Array<{ kind: string; label: RegExp }> = [
  { kind: 'catch', label: /^\*\*(?:the catch|downsides?|watch out)\s*:?\s*\*\*\s*:?/i },
  { kind: 'mind', label: /^\*\*keep in mind\s*:?\s*\*\*\s*:?/i },
  { kind: 'next', label: /^\*\*next steps?\s*:?\s*\*\*\s*:?/i },
];

function calloutKind(block: Block | undefined): string | undefined {
  return block?.type === 'p' ? CALLOUTS.find((entry) => entry.label.test(block.text))?.kind : undefined;
}

export function Markdown({ text, onCitation, onCitationHover, hot, citeKind }: MarkdownProps) {
  const options = { onCitation, onCitationHover, hot, citeKind };
  const blocks = parseBlocks(text);
  const out: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const kind = calloutKind(block);
    if (kind) {
      // A label on its own line ("**The catch:**") with bullets under it is one callout.
      const next = blocks[index + 1];
      const list = next && (next.type === 'ul' || next.type === 'ol') ? next : null;
      if (list) index++;
      out.push(
        <div key={`callout-${index}`} className="callout" data-callout={kind}>
          <p>{inline(block.type === 'p' ? block.text : '', options)}</p>
          {list && renderBlock(list, `callout-list-${index}`, options)}
        </div>,
      );
      continue;
    }
    out.push(renderBlock(block, `${block.type}-${index}`, options));
  }
  return <>{out}</>;
}

function renderBlock(block: Block, key: string, options: InlineOptions): ReactNode {
  switch (block.type) {
    case 'heading':
      return <h3 key={key}>{inline(block.text, options)}</h3>;
    case 'ul':
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{inline(item, options)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} start={block.start}>
          {block.items.map((item, i) => (
            <li key={i}>{inline(item, options)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return <blockquote key={key}>{inline(block.text, options)}</blockquote>;
    default:
      return <p key={key}>{inline(block.text, options)}</p>;
  }
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
  citeKind?(n: number): string | undefined;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[(?:\d+)(?:\]\[\d+)*\]|\[\d+(?:,\s*\d+)+\]|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\)|https?:\/\/[^\s)\[\]<>"]*[^\s)\[\].,;:!?'"<>])/g;

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
    else if ((token.startsWith('*') || token.startsWith('_')) && token.length > 2) nodes.push(<em key={key++}>{inline(token.slice(1, -1), options)}</em>);
    else if (/^\[\d/.test(token)) {
      const numbers = [...new Set(token.match(/\d+/g)?.map(Number) ?? [])];
      // A long run of citations reads as noise: show the first two and fold the rest into "+n".
      const shown = numbers.length > 3 ? numbers.slice(0, 2) : numbers;
      const pills: ReactNode[] = [];
      shown.forEach((n) => {
        pills.push(
          <button
            key={key++}
            type="button"
            className={`cite${options.hot === n ? ' hot' : ''}`}
            data-kind={options.citeKind?.(n) ?? 'archive'}
            aria-label={`Source ${n}`}
            onClick={() => options.onCitation?.(n)}
            onMouseEnter={(event) => options.onCitationHover?.(n, event.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => options.onCitationHover?.(null)}
          >
            {n}
          </button>,
        );
      });
      if (numbers.length > shown.length) {
        const rest = numbers.slice(shown.length);
        pills.push(
          <button key={key++} type="button" className="cite more" aria-label={`Sources ${rest.join(', ')}`} title={`Sources ${rest.join(', ')}`} onClick={() => options.onCitation?.(rest[0]!)}>
            +{rest.length}
          </button>,
        );
      }
      // Punctuation right after the citations stays on their line, rather than wrapping to start the next one.
      const trail = /^[.,;:!?)]+/.exec(text.slice(start + token.length))?.[0] ?? '';
      if (trail) {
        nodes.push(
          <span key={key++} className="cite-run">
            {pills}
            {trail}
          </span>,
        );
        cursor = start + token.length + trail.length;
        continue;
      }
      nodes.push(...pills);
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

/** Wraps matching terms in <mark> for search snippets. */
export function highlight(text: string, terms: string[]): ReactNode[] {
  const words = terms.filter((term) => term.length > 1).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return [text];
  const pattern = new RegExp(`\\b(${words.join('|')})\\w*`, 'gi');
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={start}>{match[0]}</mark>);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
