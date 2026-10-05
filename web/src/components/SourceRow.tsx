import type { SourceCard } from '../api';
import { formatDate, plural } from '../format';
import { IconExternal } from '../icons';
import { navigate } from '../router';

export const KIND_LABEL: Record<SourceCard['kind'], string> = { archive: 'Group thread', board: 'Student answer', announcement: 'Notice', official: 'Official page', schedule: 'Albert schedule' };

/** Where a source lives: the thread or question on this site, the course, or the official page in a new tab. */
function openSource(source: SourceCard): void {
  if (source.kind === 'archive') navigate({ name: 'post', id: source.postId });
  else if (source.kind === 'board') navigate({ name: 'question', id: source.postId });
  else if (source.kind === 'schedule') navigate(source.postId.startsWith('instructor:') ? { name: 'courses' } : { name: 'courses', code: source.postId }, source.postId.startsWith('instructor:') ? { search: `q=${encodeURIComponent(source.postId.slice(11))}` } : {});
  else if (source.url) window.open(source.url, '_blank', 'noreferrer');
  else navigate({ name: 'announcements' });
}

/** Official pages and the schedule have no author worth naming; everything else was written by someone. */
function authorOf(source: SourceCard): string {
  return source.kind !== 'official' && source.kind !== 'schedule' ? source.author : '';
}

/** What kind of source, by whom and when, as one line. */
function metaOf(source: SourceCard, withAuthor: boolean): string {
  return [KIND_LABEL[source.kind], withAuthor ? authorOf(source) : '', source.date ? formatDate(source.date) : '', source.kind === 'archive' && source.commentCount > 0 ? plural(source.commentCount, 'comment') : '']
    .filter(Boolean)
    .join(' · ');
}

interface RowProps {
  source: SourceCard;
  hot?: boolean;
  id?: string;
  onHover?(n: number | null): void;
}

/** One numbered source in the list under an answer: its title (or who wrote it), what it is, when, and where it opens. */
export function SourceRow({ source, hot, id, onHover }: RowProps) {
  const name = source.title || authorOf(source) || KIND_LABEL[source.kind];
  return (
    <div id={id} className={`source${hot ? ' hot' : ''}`} onMouseEnter={() => onHover?.(source.n)} onMouseLeave={() => onHover?.(null)}>
      <span className="source-n">{source.n}</span>
      <div className="source-main">
        <button type="button" className="source-open" onClick={() => openSource(source)}>
          {name}
        </button>
        <span className="source-meta">{metaOf(source, Boolean(source.title))}</span>
      </div>
      {source.kind === 'archive' && source.url && (
        <a className="source-ext" href={source.url} target="_blank" rel="noreferrer" title="Open on Facebook" aria-label="Open on Facebook">
          <IconExternal />
        </a>
      )}
    </div>
  );
}

/**
 * A source previewed beside its citation: what it is, its title and the matching passage. A preview opened by a tap
 * also carries its links, since there is no hover to come back to.
 */
export function SourcePreview({ source, onLocate }: { source: SourceCard; onLocate?(): void }) {
  return (
    <div className="source-preview">
      <span className="source-meta">
        {source.n} · {metaOf(source, true)}
      </span>
      {source.title && <b className="preview-title">{source.title}</b>}
      <p className="preview-text">{source.snippet || source.text}</p>
      {onLocate && (
        <div className="preview-links">
          <button type="button" className="link-btn" onClick={() => openSource(source)}>
            {source.kind === 'official' ? 'Open page' : source.kind === 'schedule' ? 'Open in Courses' : 'Open'}
          </button>
          <button type="button" className="link-btn" onClick={onLocate}>
            Show in sources
          </button>
        </div>
      )}
    </div>
  );
}
