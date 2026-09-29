import { useEffect, useMemo, useState } from 'react';
import { api, type PostSummary, type Redirect, type SearchParams } from '../api';
import { PostCard } from '../components/PostCard';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { plural, topicLabel } from '../format';
import { IconSearch } from '../icons';
import { navigate } from '../router';

interface Props {
  search: URLSearchParams;
}

const SORTS = [
  { id: 'relevance', label: 'Most relevant' },
  { id: 'newest', label: 'Newest' },
  { id: 'discussed', label: 'Most discussed' },
  { id: 'oldest', label: 'Oldest' },
] as const;

/** The page header shared by the thread list and the course index. */
export function ArchiveHead({ view }: { view: 'threads' | 'courses' }) {
  return (
    <div className="page-head">
      <div>
        <h1>Archive</h1>
        <p>What the group has already worked out, minus the noise.</p>
      </div>
      <Segmented value={view} label="Archive view" options={[{ id: 'threads', label: 'Threads' }, { id: 'courses', label: 'Courses' }]} onChange={(next) => navigate(next === 'courses' ? { name: 'courses' } : { name: 'browse' })} />
    </div>
  );
}

export function BrowsePage({ search }: Props) {
  const { home } = useApp();
  const [q, setQ] = useState(search.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const topic = search.get('topic') ?? '';
  const year = search.get('year') ?? '';
  const sort = (search.get('sort') as SearchParams['sort']) ?? (q ? 'relevance' : 'newest');
  const [results, setResults] = useState<PostSummary[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [redirect, setRedirect] = useState<Redirect | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (debounced) params.set('q', debounced);
    else params.delete('q');
    const next = params.toString();
    if (next !== search.toString()) navigate({ name: 'browse' }, { replace: true, search: next, keepScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(search);
    if (value) params.set(key, value);
    else params.delete(key);
    navigate({ name: 'browse' }, { replace: true, search: params.toString(), keepScroll: true });
  };

  const years = useMemo(() => {
    if (!home?.stats.newestPost || !home.stats.oldestPost) return [];
    const newest = Number(home.stats.newestPost.slice(0, 4));
    const oldest = Number(home.stats.oldestPost.slice(0, 4));
    return Array.from({ length: newest - oldest + 1 }, (_, i) => String(newest - i));
  }, [home]);

  const params = (pageNumber: number): SearchParams => ({
    q: debounced || undefined,
    topic: topic || undefined,
    from: year ? `${year}-01` : undefined,
    to: year ? `${year}-12` : undefined,
    sort,
    page: pageNumber,
    pageSize: 20,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(1);
    api
      .search(params(1))
      .then((result) => {
        if (cancelled) return;
        setResults(result.results);
        setTerms(result.terms);
        setTotal(result.total);
        setRedirect(result.redirect);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Search failed.');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, topic, year, sort]);

  const loadMore = async () => {
    const next = page + 1;
    setLoading(true);
    try {
      const result = await api.search(params(next));
      setResults((current) => [...current, ...result.results]);
      setPage(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="content">
      <ArchiveHead view="threads" />
      <label className="searchbar">
        <IconSearch />
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search threads" aria-label="Search threads" />
        {q && (
          <button type="button" className="btn ghost sm" onClick={() => setQ('')}>
            Clear
          </button>
        )}
      </label>
      <div className="filters">
        <select className="select" value={sort} onChange={(event) => setParam('sort', event.target.value)} aria-label="Sort">
          {SORTS.filter((option) => option.id !== 'relevance' || debounced).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {years.length > 1 && (
          <select className="select" value={year} onChange={(event) => setParam('year', event.target.value)} aria-label="Year">
            <option value="">Any year</option>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        {home?.topics.slice(0, 10).map((entry) => (
          <button key={entry.id} type="button" className={`chip${topic === entry.id ? ' on' : ''}`} aria-pressed={topic === entry.id} onClick={() => setParam('topic', topic === entry.id ? '' : entry.id)}>
            {topicLabel(entry.id)}
          </button>
        ))}
      </div>
      {redirect && (
        <div className="redirect" style={{ marginBottom: 16 }}>
          <h3>{redirect.title}</h3>
          <p>{redirect.message}</p>
          <div className="row">
            <a className="btn" href={redirect.link.url} target="_blank" rel="noreferrer">
              {redirect.link.label}
            </a>
          </div>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      <div className="result-count" aria-live="polite">
        {loading && results.length === 0 ? 'Searching' : `${plural(total, 'thread')}${debounced ? ` for “${debounced}”` : ''}${topic ? ` in ${topicLabel(topic)}` : ''}${year ? ` from ${year}` : ''}`}
      </div>
      <div className="post-list">
        {results.map((post) => (
          <PostCard key={post.id} post={post} terms={terms} />
        ))}
      </div>
      {!loading && results.length === 0 && !error && !redirect && (
        <div className="empty">
          <h3>Nothing matched</h3>
          Try fewer words, a surname, or a course code such as CS-UH 1001.
        </div>
      )}
      {results.length < total && (
        <div className="pager">
          <button type="button" className="btn" onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'Loading' : `Show more (${(total - results.length).toLocaleString()} left)`}
          </button>
        </div>
      )}
    </div>
  );
}
