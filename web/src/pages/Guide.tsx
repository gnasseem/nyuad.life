import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type GuideCourse, type GuideDetail, type GuideItem, type GuideSection } from '../api';
import { PostRow } from '../components/PostRow';
import { useApp } from '../context';
import { formatDate, plural } from '../format';
import { IconBack, IconChevronRight, IconClose, IconExternal } from '../icons';
import { navigate, onLinkClick } from '../router';

interface Props {
  section?: string;
  id?: string;
}

const CONFIDENCE_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

/** Official NYUAD pages by section and every course with a code; opening an entry slides in a drawer with the summary. */
export function GuidePage({ section, id }: Props) {
  const [index, setIndex] = useState<{ official: { available: boolean }; sections: GuideSection[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.guide
      .sections()
      .then(setIndex)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the guide.'));
  }, []);

  const closeDetail = () => navigate({ name: 'guide', section }, { keepScroll: true });
  const current = section ? index?.sections.find((entry) => entry.id === section) : undefined;

  return (
    <div className="page">
      {section && (
        <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'guide' })}>
          <IconBack /> Guide
        </button>
      )}
      <div className="page-head">
        <div>
          <h1>{current?.label ?? 'Guide'}</h1>
          <p>{section ? current?.blurb ?? '' : 'Official NYUAD pages and what students said about them.'}</p>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {index && !index.official.available && (
        <div className="alert" style={{ marginBottom: 16 }}>
          Official pages have not been crawled on this server yet, so only courses mentioned in threads are listed.
        </div>
      )}
      {!section && index && (
        <div className="list">
          {index.sections
            .filter((entry) => entry.count > 0 || entry.id === 'courses')
            .map((entry) => (
              <a key={entry.id} href={`/guide/${entry.id}`} className="list-row" onClick={onLinkClick}>
                <span className="grow">
                  <span className="title">{entry.label}</span>
                  <span className="sub">{entry.blurb}</span>
                </span>
                <span className="label">{entry.id === 'courses' ? plural(entry.count, 'course') : plural(entry.count, 'page')}</span>
                <IconChevronRight className="chev" />
              </a>
            ))}
        </div>
      )}
      {!section && !index && !error && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}
      {section === 'courses' && <CourseList selected={id} />}
      {section && section !== 'courses' && <SectionList section={section} selected={id} />}
      {section && id && <Detail section={section} id={id} onClose={closeDetail} />}
    </div>
  );
}

function CourseList({ selected }: { selected?: string }) {
  const [items, setItems] = useState<GuideCourse[] | null>(null);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  useEffect(() => {
    api.guide
      .courses()
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, []);
  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items ?? []) counts.set(item.department, (counts.get(item.department) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
  }, [items]);
  const needle = q.trim().toLowerCase();
  const shown = (items ?? []).filter((item) => (!dept || item.department === dept) && (!needle || item.code.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle)));
  return (
    <>
      <input className="input filter" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Filter by code or title" aria-label="Filter courses" />
      <div className="chips" style={{ marginBottom: 16 }}>
        <button type="button" className={`chip${dept ? '' : ' on'}`} onClick={() => setDept('')}>
          All
        </button>
        {departments.slice(0, 18).map((code) => (
          <button key={code} type="button" className={`chip${dept === code ? ' on' : ''}`} onClick={() => setDept(dept === code ? '' : code)}>
            {code}
          </button>
        ))}
      </div>
      {!items && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}
      {items && shown.length === 0 && <div className="empty">No matching courses.</div>}
      {items && shown.length > 0 && (
        <div className="list">
          {shown.slice(0, 400).map((item) => (
            <a key={item.code} href={`/guide/courses/${encodeURIComponent(item.code)}`} className={`list-row course-row${selected === item.code ? ' on' : ''}`} onClick={onLinkClick}>
              <span className="code">{item.code}</span>
              <span className="grow">
                <span className="title">{item.title}</span>
              </span>
              <span className="n">{[item.official ? 'Bulletin' : '', item.threads ? plural(item.threads, 'thread') : ''].filter(Boolean).join(', ')}</span>
              <IconChevronRight className="chev" />
            </a>
          ))}
        </div>
      )}
      {items && shown.length > 400 && (
        <p className="label" style={{ marginTop: 8 }}>
          Showing 400 of {shown.length}. Filter to see the rest.
        </p>
      )}
    </>
  );
}

function SectionList({ section, selected }: { section: string; selected?: string }) {
  const [items, setItems] = useState<GuideItem[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setItems(null);
    api.guide
      .section(section)
      .then((result) => setItems(result.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this section.'));
  }, [section]);
  const needle = q.trim().toLowerCase();
  const shown = (items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.blurb.toLowerCase().includes(needle));
  return (
    <>
      {error && <div className="alert error">{error}</div>}
      {items && items.length > 8 && <input className="input filter" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Filter" aria-label="Filter pages" />}
      {!items && !error && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}
      {items && shown.length === 0 && <div className="empty">No pages.</div>}
      {items && shown.length > 0 && (
        <div className="list">
          {shown.map((item) => (
            <a key={item.id} href={`/guide/${section}/${item.id}`} className={`list-row${selected === item.id ? ' on' : ''}`} onClick={onLinkClick}>
              <span className="grow">
                <span className="title">{item.title}</span>
                <span className="sub">{item.blurb}</span>
              </span>
              <IconChevronRight className="chev" />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function Detail({ section, id, onClose }: { section: string; id: string; onClose(): void }) {
  const { setAskPrefill } = useApp();
  const [detail, setDetail] = useState<GuideDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setDetail(null);
    setError('');
    (section === 'courses' ? api.guide.course(id) : api.guide.item(id))
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this entry.'));
  }, [section, id]);

  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const ask = () => {
    if (!detail) return;
    setAskPrefill({ question: detail.kind === 'course' ? `What do students say about ${detail.code}?` : `What should I know about ${detail.title}?`, autoSend: true });
    navigate({ name: 'ask' });
  };

  const title = detail?.title ?? (section === 'courses' ? id : 'Loading');
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div className="grow">
            <div className="label">{detail?.breadcrumbs?.length ? detail.breadcrumbs.join(' / ') : section === 'courses' ? 'Course' : 'Official page'}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="drawer-body">
          {error && <div className="alert error">{error}</div>}
          {!detail && !error && (
            <div className="stack" aria-busy="true">
              <div className="skeleton" style={{ height: 16, width: '60%' }} />
              <div className="skeleton" style={{ height: 80 }} />
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          )}
          {detail && (
            <>
              <div className="row wrap" style={{ marginBottom: 16 }}>
                <button type="button" className="btn sm primary" onClick={ask}>
                  Ask about this
                </button>
                {detail.official && (
                  <a className="btn sm" href={detail.official.url} target="_blank" rel="noreferrer">
                    <IconExternal /> Open page
                  </a>
                )}
                {detail.official?.credits && <span className="tag">{detail.official.credits} credits</span>}
                {detail.threadCount > 0 && <span className="tag">{plural(detail.threadCount, 'thread')}</span>}
              </div>
              {detail.summary ? (
                <Summary summary={detail.summary} sources={detail.sources} />
              ) : (
                <div className="alert">{detail.official || detail.threads.length ? 'No summary: no model key is set on this server.' : 'No information for this entry.'}</div>
              )}
              {detail.official && (
                <>
                  <h3>Official page, fetched {formatDate(detail.official.fetchedAt)}</h3>
                  <div className="official-text">{detail.official.text}</div>
                </>
              )}
              {detail.threads.length > 0 && (
                <>
                  <h3>What students said</h3>
                  <div className="list">
                    {detail.threads.map((post) => (
                      <PostRow key={post.id} post={post} />
                    ))}
                  </div>
                </>
              )}
              {detail.related && detail.related.length > 0 && (
                <>
                  <h3>Related pages</h3>
                  <div className="sources-list">
                    {detail.related.map((entry) => (
                      <a key={entry.id} href={`/guide/${detail.section}/${entry.id}`} onClick={onLinkClick}>
                        <IconChevronRight style={{ width: 14, height: 14, flex: 'none' }} />
                        <span className="t">{entry.title}</span>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Summary({ summary, sources }: { summary: NonNullable<GuideDetail['summary']>; sources: GuideDetail['sources'] }) {
  const cite = (text: string) =>
    text.split(/(\[\d+(?:\]\[\d+)*\])/).map((part, index) => {
      if (!/^\[\d/.test(part)) return part;
      return part.match(/\d+/g)?.map((n) => (
        <span key={`${index}-${n}`} className="cite" title={sources.find((source) => source.n === Number(n))?.title}>
          {n}
        </span>
      ));
    });
  const sections: Array<[string, string[]]> = [
    ['Facts', summary.facts],
    ['What students said', summary.students],
    ['Keep in mind', summary.keepInMind],
  ];
  return (
    <div className="summary">
      <p>{cite(summary.overview)}</p>
      {sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => (
          <div key={heading}>
            <h3 style={{ marginTop: 0 }}>{heading}</h3>
            <ul>
              {lines.map((line, i) => (
                <li key={i}>{cite(line)}</li>
              ))}
            </ul>
          </div>
        ))}
      <div className="meta">
        <span className={`status confidence ${summary.confidence}`}>
          <span className="dot" /> {CONFIDENCE_LABEL[summary.confidence]}
        </span>
        <span>Written by the model on {formatDate(summary.createdAt.slice(0, 10))} from the sources below.</span>
      </div>
      {sources.length > 0 && (
        <div className="sources-list">
          {sources.map((source) => {
            const inner = (
              <>
                <span className="source-n">{source.n}</span>
                <span className="t">{source.title}</span>
                <span>{source.kind === 'official' ? 'Official' : source.kind === 'board' ? 'Student answer' : 'Thread'}</span>
              </>
            );
            if (source.kind === 'official')
              return (
                <a key={source.n} href={source.url} target="_blank" rel="noreferrer">
                  {inner}
                </a>
              );
            return (
              <a key={source.n} href={source.kind === 'board' ? `/questions/${source.postId}` : `/post/${source.postId}`} onClick={onLinkClick}>
                {inner}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
