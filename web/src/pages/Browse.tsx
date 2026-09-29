import { useEffect, useMemo, useState } from 'react';
import { api, type PostSummary, type SearchParams } from '../api';
import { PostCard } from '../components/PostCard';
import { useApp } from '../context';
import { topicLabel } from '../format';
import { IconSearch } from '../icons';
import { navigate } from '../router';

interface Props {
  search: URLSearchParams;
  onNeedAccess(): void;
}

const SORTS = [
  { id: 'relevance', label: 'Most relevant' },
  { id: 'newest', label: 'Newest' },
  { id: 'discussed', label: 'Most discussed' },
  { id: 'oldest', label: 'Oldest' },
] as const;

export function BrowsePage({ search, onNeedAccess }: Props) {
  const { home } = useApp();
  const [q, setQ] = useState(search.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const topic = search.get('topic') ?? '';
  const year = search.get('year') ?? '';
  const sort = (search.get('sort') as SearchParams['sort']) ?? (q ? 'relevance' : 'newest');
  const [results, setResults] = useState<PostSummary[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
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
    if (next !== search.toString()) navigate({ name: 'browse' }, { replace: true, search: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(search);
    if (value) params.set(key, value);
    else params.delete(key);
    navigate({ name: 'browse' }, { replace: true, search: params.toString() });
  };

  const years = useMemo(() => {
    if (!home?.stats.newestPost || !home.stats.oldestPost) return [];
    const newest = Number(home.stats.newestPost.slice(0, 4));
    const oldest = Number(home.stats.oldestPost.slice(0, 4));
    return Array.from({ length: newest - oldest + 1 }, (_, i) => String(newest - i));
  }, [home]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(1);
    api
      .search({ q: debounced || undefined, topic: topic || undefined, from: year ? `${year}-01` : undefined, to: year ? `${year}-12` : undefined, sort, page: 1, pageSize: 20 })
      .then((result) => {
        if (cancelled) return;
        setResults(result.results);
        setTerms(result.terms);
        setTotal(result.total);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.status === 401) onNeedAccess();
        setError(err instanceof Error ? err.message : 'Search failed.');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, topic, year, sort, onNeedAccess]);

  const loadMore = async () => {
    const next = page + 1;
    setLoading(true);
    try {
      const result = await api.search({ q: debounced || undefined, topic: topic || undefined, from: year ? `${year}-01` : undefined, to: year ? `${year}-12` : undefined, sort, page: next, pageSize: 20 });
      setResults((current) => [...current, ...result.results]);
      setPage(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="display">Browse the archive</h1>
        <p>Search every post and comment, or filter by topic and year.</p>
      </div>
      <label className="searchbar">
        <IconSearch />
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search posts and comments… e.g. Dania calculus, A5 laundry, Shanghai housing" autoFocus />
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
        {home?.topics.slice(0, 12).map((entry) => (
          <button key={entry.id} type="button" className={`chip${topic === entry.id ? ' on' : ''}`} onClick={() => setParam('topic', topic === entry.id ? '' : entry.id)}>
            {topicLabel(entry.id)}
          </button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="result-count">
        {loading && results.length === 0 ? 'Searching…' : `${total.toLocaleString()} ${total === 1 ? 'post' : 'posts'}${debounced ? ` for “${debounced}”` : ''}`}
      </div>
      <div className="post-list">
        {results.map((post) => (
          <PostCard key={post.id} post={post} terms={terms} />
        ))}
      </div>
      {!loading && results.length === 0 && !error && (
        <div className="empty">
          <h3>Nothing matched</h3>
          Try fewer words, a surname, or a course code like CS-UH 1001.
        </div>
      )}
      {results.length < total && (
        <div className="pager">
          <button type="button" className="btn" onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
