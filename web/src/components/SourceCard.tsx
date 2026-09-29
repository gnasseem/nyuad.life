import type { SourceCard as Source } from '../api';
import { formatDate } from '../format';
import { navigate } from '../router';

interface Props {
  source: Source;
  hot: boolean;
  onHover(n: number | null): void;
  terms?: string[];
}

export function SourceCard({ source, hot, onHover }: Props) {
  return (
    <div id={`source-${source.n}`} className={`source${hot ? ' hot' : ''}`} onMouseEnter={() => onHover(source.n)} onMouseLeave={() => onHover(null)}>
      <div className="source-top">
        <span className="source-n">{source.n}</span>
        <span className="source-author">{source.author || 'Unknown'}</span>
        <span className="faint small" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{formatDate(source.date)}</span>
      </div>
      <div className="source-snippet">{source.snippet || source.text}</div>
      <div className="source-actions">
        <button type="button" onClick={() => navigate({ name: 'post', id: source.postId })}>
          Thread · {source.commentCount} {source.commentCount === 1 ? 'comment' : 'comments'}
        </button>
        {source.url && (
          <a href={source.url} target="_blank" rel="noreferrer">
            Facebook ↗
          </a>
        )}
      </div>
    </div>
  );
}
