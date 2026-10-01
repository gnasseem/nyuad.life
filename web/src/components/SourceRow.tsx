import type { SourceCard } from '../api';
import { formatDate, plural } from '../format';
import { navigate } from '../router';

interface Props {
  source: SourceCard;
  hot?: boolean;
  id?: string;
  onHover?(n: number | null): void;
}

export const KIND_LABEL: Record<SourceCard['kind'], string> = { archive: 'Group thread', board: 'Student answer', announcement: 'Notice', official: 'Official page' };

/** One numbered source under an answer: what kind, who, when, the matching passage and where it opens. Its colour is the line it lives on. */
export function SourceRow({ source, hot, id, onHover }: Props) {
  const open = () => {
    if (source.kind === 'archive') navigate({ name: 'post', id: source.postId });
    else if (source.kind === 'board') navigate({ name: 'question', id: source.postId });
    else if (source.url) window.open(source.url, '_blank', 'noreferrer');
    else navigate({ name: 'announcements' });
  };
  return (
    <div id={id} className={`source${hot ? ' hot' : ''}`} data-kind={source.kind} onMouseEnter={() => onHover?.(source.n)} onMouseLeave={() => onHover?.(null)}>
      <span className="source-n">{source.n}</span>
      <div className="source-top">
        <span className="kind">{KIND_LABEL[source.kind]}</span>
        {source.kind !== 'official' && source.author && <b>{source.author}</b>}
        {source.date && <span>{formatDate(source.date)}</span>}
        {source.kind === 'archive' && source.commentCount > 0 && <span>{plural(source.commentCount, 'comment')}</span>}
      </div>
      {source.title && <div className="source-title">{source.title}</div>}
      <div className="source-text">{source.snippet || source.text}</div>
      <div className="source-links">
        <button type="button" onClick={open}>
          {source.kind === 'official' ? 'Open page' : 'Open'}
        </button>
        {source.kind === 'archive' && source.url && (
          <a href={source.url} target="_blank" rel="noreferrer">
            Facebook
          </a>
        )}
      </div>
    </div>
  );
}
