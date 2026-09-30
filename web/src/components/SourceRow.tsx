import type { SourceCard } from '../api';
import { formatDate } from '../format';
import { navigate } from '../router';

interface Props {
  source: SourceCard;
  hot?: boolean;
  id?: string;
  onHover?(n: number | null): void;
}

const KIND_LABEL: Record<SourceCard['kind'], string> = { archive: 'Thread', board: 'Student answer', announcement: 'Announcement', official: 'Official page' };

export function SourceRow({ source, hot, id, onHover }: Props) {
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
        <b>{source.author || 'Unknown'}</b>
        <span>{formatDate(source.date)}</span>
        <span>{KIND_LABEL[source.kind]}</span>
      </div>
      {source.title && <div className="source-title">{source.title}</div>}
      <div className="source-text">{source.snippet || source.text}</div>
      <div className="source-links">
        <button type="button" onClick={open}>
          Open
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
