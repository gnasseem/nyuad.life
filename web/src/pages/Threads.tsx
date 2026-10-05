import { useEffect, useRef, useState } from 'react';
import { api, type PostSummary } from '../api';
import { PostRow } from '../components/PostRow';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { plural, topicLabel } from '../format';
import { IconSearch } from '../icons';
import { navigate } from '../router';

type Sort = 'relevance' | 'newest' | 'discussed';

export const TOPICS = ['courses', 'professors', 'housing', 'study-away', 'visa-travel', 'jobs', 'money', 'food', 'health', 'transport', 'tech', 'events', 'research', 'grad-school', 'marketplace', 'lost-found'];

/** The group's own threads, searched by keyword and meaning, with no model writing anything: the archive as it is. */
export function ThreadSearch() {
  const { setAskPrefill } = useApp();
  const initial = new URLSearchParams(window.location.search);
  const [q, setQ] = useState(initial.get('q') ?? '');
  const [topic, setTopic] = useState(initial.get('topic') ?? '');
  const [sort, setSort] = useState<Sort>((initial.get('sort') as Sort) || 'relevance');
  const [results, setResults] = useState<{ total: number; terms: string[]; items: PostSummary[]; page: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);

  const query = q.trim();
  const effectiveSort: Sort = !query && sort === 'relevance' ? 'newest' : sort;

  useEffect(() => {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    if (topic) search.set('topic', topic);
    if (sort !== 'relevance') search.set('sort', sort);
    navigate({ name: 'threads' }, { replace: true, keepScroll: true, search: search.toString() });
    if (query.length === 1) return;
    const id = ++request.current;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        api
          .search({ q: query, topic, sort: effectiveSort })
          .then((result) => {
            if (id !== request.current) return;
            setResults({ total: result.total, terms: result.terms, items: result.results, page: 1 });
            setError('');
          })
          .catch((err) => id === request.current && setError(err instanceof Error ? err.message : 'Search failed.'))
          .finally(() => id === request.current && setLoading(false));
      },
      query ? 280 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [query, topic, sort, effectiveSort]);

  const more = () => {
    if (!results) return;
    const id = ++request.current;
    setLoading(true);
    api
      .search({ q: query, topic, sort: effectiveSort, page: results.page + 1 })
      .then((result) => id === request.current && setResults({ ...results, items: [...results.items, ...result.results], page: results.page + 1 }))
      .catch((err) => id === request.current && setError(err instanceof Error ? err.message : 'Search failed.'))
      .finally(() => id === request.current && setLoading(false));
  };

  const sorts: Array<{ id: Sort; label: string }> = query ? [{ id: 'relevance', label: 'Best match' }, { id: 'newest', label: 'Newest' }, { id: 'discussed', label: 'Most discussed' }] : [{ id: 'newest', label: 'Newest' }, { id: 'discussed', label: 'Most discussed' }];
  const topicButtons = (
    <>
      <button type="button" className={topic ? undefined : 'on'} onClick={() => setTopic('')}>
        All topics
      </button>
      {TOPICS.map((id) => (
        <button key={id} type="button" className={topic === id ? 'on' : undefined} onClick={() => setTopic(topic === id ? '' : id)}>
          {topicLabel(id)}
        </button>
      ))}
    </>
  );

  return (
    <div className="split">
      <div>
        <div className="search-field big" style={{ marginBottom: 14 }}>
          <IconSearch />
          <input
            className="input"
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            autoFocus={window.matchMedia('(min-width: 900px)').matches}
          />
          {loading && <span className="spinner" aria-label="Searching" />}
        </div>
        <div className="threads-topics-mobile">
          <div className="chips scroll-x">
            <button type="button" className={`chip${topic ? '' : ' on'}`} onClick={() => setTopic('')}>
              All topics
            </button>
            {TOPICS.map((id) => (
              <button key={id} type="button" className={`chip${topic === id ? ' on' : ''}`} onClick={() => setTopic(topic === id ? '' : id)}>
                {topicLabel(id)}
              </button>
            ))}
          </div>
        </div>
        <div className="results-head">
          <span className="faint small">{results && (query || topic) && results.total > 0 ? plural(results.total, 'result') : ' '}</span>
          <Segmented<Sort> value={effectiveSort} onChange={setSort} label="Sort" options={sorts} />
        </div>
        {error && <div className="alert error">{error}</div>}
        {!results && !error && (
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 96 }} />
          </div>
        )}
        {results && results.items.length === 0 && (
          <div className="empty">
            Nothing matches.
            <br />
            {query && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setAskPrefill({ question: query, autoSend: true });
                  navigate({ name: 'ask' });
                }}
              >
                Ask “{query.slice(0, 60)}”
              </button>
            )}
          </div>
        )}
        {results && results.items.length > 0 && (
          <div className={`list${loading ? ' dim' : ''}`}>
            {results.items.map((post) => (
              <PostRow key={post.id} post={post} terms={results.terms} />
            ))}
          </div>
        )}
        {results && results.items.length < results.total && (
          <div className="load-more">
            <button type="button" className="btn" onClick={more} disabled={loading}>
              {loading ? 'Loading' : 'Show more'}
            </button>
          </div>
        )}
      </div>
      <aside className="rail threads-topics">
        <div className="rail-block">
          <h2>Topics</h2>
          <div className="topic-list">{topicButtons}</div>
        </div>
      </aside>
    </div>
  );
}
