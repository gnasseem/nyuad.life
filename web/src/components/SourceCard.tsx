import type { SourceCard as Source } from '../api';
import { formatDate, plural } from '../format';
import { navigate } from '../router';

interface Props {
  source: Source;
  hot?: boolean;
  id?: string;
  onHover?(n: number | null): void;
}

export function SourceCard({ source, hot, id, onHover }: Props) {
  const kind = source.kind === 'board' ? 'Student answer' : source.kind === 'announcement' ? 'Announcement' : '';
  const open = () => {
    if (source.kind === 'archive') navigate({ name: 'post', id: source.postId });
    else if (source.kind === 'board') navigate({ name: 'question', id: source.postId });
    else if (source.url) window.open(source.url, '_blank', 'noreferrer');
    else navigate({ name: 'announcements' });
  };
  return (
    <div id={id} className={`source${hot ? ' hot' : ''}`} onMouseEnter={() => onHover?.(source.n)} onMouseLeave={() => onHover?.(null)}>
      <div className="source-top">
        <span className="source-n">{source.n}</span>
        <span className="source-who">{source.author || 'Unknown'}</span>
        <span className="source-date small">{formatDate(source.date)}</span>
      </div>
      {kind && <span className="source-kind">{kind}</span>}
      {source.title && <div className="source-title">{source.title}</div>}
      <div className="source-text">{source.snippet || source.text}</div>
      <div className="source-links">
        <button type="button" onClick={open}>
          {source.kind === 'archive' ? `Open thread · ${plural(source.commentCount, 'comment')}` : source.kind === 'board' ? 'Open question' : source.url ? 'Open link' : 'See announcements'}
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
