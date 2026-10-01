import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type GuideCourse, type GuideDetail, type GuideItem, type GuideSection } from '../api';
import { SearchList, useListKeys, useSearchItems } from '../components/Palette';
import { PostRow } from '../components/PostRow';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { topicLabel } from '../format';
import { IconBack, IconChevronRight, IconClose, IconExternal, IconSearch } from '../icons';
import { useLatest, useMedia, usePresence } from '../motion';
import { navigate, onLinkClick } from '../router';
import { ThreadSearch, TOPICS } from './Threads';

interface Props {
  section?: string;
  id?: string;
}

const CONFIDENCE_LABEL = { medium: 'Partly sourced', low: 'Weakly sourced' };
const WIDE = '(min-width: 1240px)';
const PAGE_ROWS = 60;

/** Each section's name in Arabic, for its station sign. */
const ARABIC: Record<string, string> = {
  courses: 'المساقات',
  threads: 'نقاشات المجموعة',
  majors: 'التخصصات',
  minors: 'التخصصات الفرعية',
  core: 'المنهج الأساسي',
  'study-away': 'الدراسة في الخارج',
  academics: 'الشؤون الأكاديمية',
  housing: 'السكن',
  money: 'المال والمساعدات',
  visa: 'التأشيرة والسفر',
  health: 'الصحة والعافية',
  careers: 'المهن والتدريب',
  research: 'البحث',
  campus: 'الحياة الجامعية',
  admissions: 'القبول',
  policies: 'السياسات',
};

/** The group's threads, official NYUAD pages by section and every course with a code; an entry opens beside the list on wide screens and over it on narrow ones. */
export function GuidePage({ section, id }: Props) {
  const [index, setIndex] = useState<{ official: { available: boolean }; sections: GuideSection[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.guide
      .sections()
      .then(setIndex)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the guide.'));
  }, []);

  const current = section ? index?.sections.find((entry) => entry.id === section) : undefined;

  if (!section) return <GuideHome index={index} error={error} />;

  const title = current?.label ?? (section === 'courses' ? 'Courses' : section === 'threads' ? 'Group threads' : 'Guide');
  return (
    <div className="page">
      <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'guide' })}>
        <IconBack /> Guide
      </button>
      <Sign title={title} ar={ARABIC[section]} />
      {error && <div className="alert error">{error}</div>}
      {section === 'threads' && <ThreadSearch />}
      {section === 'courses' && <CourseList selected={id} />}
      {section !== 'courses' && section !== 'threads' && <SectionList section={section} label={title} selected={id} />}
    </div>
  );
}

function GuideHome({ index, error }: { index: { official: { available: boolean }; sections: GuideSection[] } | null; error: string }) {
  const { health } = useApp();
  const [courses, setCourses] = useState<GuideCourse[] | null>(null);
  useEffect(() => {
    api.guide
      .courses()
      .then((result) => setCourses(result.items))
      .catch(() => setCourses([]));
  }, []);
  const discussed = useMemo(() => (courses ?? []).filter((course) => course.threads > 0).sort((a, b) => b.threads - a.threads || a.code.localeCompare(b.code)).slice(0, 8), [courses]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of index?.sections ?? []) map.set(entry.id, entry.count);
    if (health?.archive) map.set('threads', health.archive.posts);
    return map;
  }, [index, health]);

  return (
    <div className="page">
      <Sign title="Guide" ar="الدليل" />
      <div className="guide-top">
        <GuideSearch />
      </div>
      {error && <div className="alert error">{error}</div>}
      {index ? (
        <>
          <GuideMap counts={counts} />
          <GuideLines counts={counts} labels={new Map(index.sections.map((entry) => [entry.id, entry.label]))} />
        </>
      ) : (
        !error && <div className="skeleton" style={{ height: 320, marginBottom: 40 }} aria-busy="true" />
      )}
      <div className="guide-cols">
        <section>
          <h2 className="section-title">Popular courses</h2>
          {!courses ? (
            <div className="skeleton" style={{ height: 240 }} />
          ) : discussed.length === 0 ? (
            <div className="empty">Nothing yet.</div>
          ) : (
            <div className="list">
              {discussed.map((course) => (
                <a key={course.code} href={`/guide/courses/${encodeURIComponent(course.code)}`} className="row course-row" onClick={onLinkClick}>
                  <span className="code">{course.code}</span>
                  <span className="grow">
                    <span className="title">{course.title || course.code}</span>
                  </span>
                  <IconChevronRight className="chev" />
                </a>
              ))}
            </div>
          )}
        </section>
        <section>
          <h2 className="section-title">Browse the group</h2>
          <div className="chips">
            {TOPICS.slice(0, 8).map((topic) => (
              <a key={topic} className="chip" href={`/guide/threads?topic=${encodeURIComponent(topic)}`} onClick={onLinkClick}>
                {topicLabel(topic)}
              </a>
            ))}
            <a className="chip ghost" href="/guide/threads" onClick={onLinkClick}>
              All threads <IconChevronRight />
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One box over everything in the guide: courses by code or name, sections, matching threads, or straight to Ask. */
function GuideSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const done = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);
  const items = useSearchItems(query, done, { threads: true }).filter((item) => item.group !== 'Go to' && item.group !== 'Settings' && item.group !== 'Recent');
  const { active, setActive, onKeyDown } = useListKeys(items, () => setOpen(false));

  useEffect(() => {
    const onDown = (event: MouseEvent) => !wrapRef.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div className="gsearch" ref={wrapRef}>
      <div className="search-field big">
        <IconSearch />
        <input
          className="input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search courses, topics, pages"
          aria-label="Search the guide"
          role="combobox"
          aria-expanded={open && query.trim().length > 0}
        />
      </div>
      {open && query.trim() && items.length > 0 && (
        <div className="gresults">
          <SearchList items={items} active={active} setActive={setActive} />
        </div>
      )}
    </div>
  );
}

type Label = 'above' | 'below' | 'above-end' | 'below-end';
const STATIONS: Record<string, { x: number; y: number; at: Label; big?: boolean; name?: string }> = {
  majors: { x: 100, y: 200, at: 'below' },
  minors: { x: 210, y: 200, at: 'below' },
  core: { x: 320, y: 200, at: 'below', name: 'Core' },
  courses: { x: 460, y: 200, at: 'above-end', big: true },
  threads: { x: 620, y: 200, at: 'above', big: true, name: 'Group threads' },
  campus: { x: 780, y: 200, at: 'below-end' },
  housing: { x: 890, y: 200, at: 'below' },
  health: { x: 1000, y: 200, at: 'below', name: 'Health' },
  academics: { x: 568, y: 110, at: 'above' },
  'study-away': { x: 706, y: 110, at: 'above' },
  admissions: { x: 330, y: 290, at: 'below' },
  policies: { x: 220, y: 290, at: 'below' },
  careers: { x: 892, y: 110, at: 'above', name: 'Careers' },
  research: { x: 1014, y: 110, at: 'above' },
  money: { x: 888, y: 290, at: 'below', name: 'Money & aid' },
  visa: { x: 1018, y: 290, at: 'below', name: 'Visa & travel' },
};
const TRACKS = ['M 50 200 H 1050', 'M 460 200 L 550 110 H 746', 'M 460 200 L 370 290 H 180', 'M 780 200 L 870 110 H 1050', 'M 780 200 L 870 290 H 1050'];
const SHORT: Record<string, string> = { majors: 'Majors', minors: 'Minors', courses: 'Courses', campus: 'Campus life', housing: 'Housing', academics: 'Academics', 'study-away': 'Study away', admissions: 'Admissions', policies: 'Policies', research: 'Research' };

/** The guide as a line map: one cobalt line through the sections, branching four ways, with the group's threads as the big interchange and a walking transfer to Ask. */
function GuideMap({ counts }: { counts: Map<string, number> }) {
  const go = (event: React.MouseEvent<Element>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    const [path, search] = href.split('?');
    const parts = path!.split('/').filter(Boolean);
    if (parts[0] === 'guide') navigate({ name: 'guide', section: parts[1] }, search ? { search } : {});
    else navigate({ name: 'ask' });
  };
  return (
    <div className="gmap" aria-label="Map of the guide">
      <svg viewBox="20 50 1060 310" role="img" aria-label="Guide sections as stations on a line map">
        {TRACKS.map((d, index) => (
          <path key={d} className="trunk draw" d={d} pathLength={1} style={{ animationDelay: `${index * 0.12}s` }} />
        ))}
        <path className="link-ask" d="M 620 214 V 318" pathLength={1} />
        <a href="/" className="gst big" onClick={(event) => go(event, '/')} style={{ '--i': 17 } as React.CSSProperties} aria-label="Ask, which uses all of this">
          <circle className="hit" cx={620} cy={334} r={26} />
          <circle className="ring" cx={620} cy={334} r={13} style={{ stroke: 'var(--ink)' }} />
          <text x={642} y={339}>
            Ask
          </text>
        </a>
        {Object.entries(STATIONS).map(([id, station], index) => {
          const count = counts.get(id) ?? 0;
          const name = station.name ?? SHORT[id] ?? id;
          const href = `/guide/${id}`;
          const end = station.at.endsWith('end');
          const above = station.at.startsWith('above');
          const tx = end ? station.x - (station.big ? 24 : 14) : station.x;
          const ty = station.y + (above ? (station.big ? -30 : -22) : station.big ? 44 : 34);
          return (
            <a key={id} href={href} className={`gst${station.big ? ' big' : ''}${count === 0 ? ' dim' : ''}`} onClick={(event) => go(event, href)} style={{ '--i': index } as React.CSSProperties} aria-label={`${name}, ${count}`}>
              <circle className="hit" cx={station.x} cy={station.y} r={station.big ? 28 : 20} />
              <circle className="ring" cx={station.x} cy={station.y} r={station.big ? 17 : 9} />
              <text x={tx} y={station.big && above ? ty - 6 : ty} textAnchor={end ? 'end' : 'middle'}>
                {name}
              </text>
            </a>
          );
        })}
      </svg>
    </div>
  );
}

const LINE_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: 'Academics', ids: ['courses', 'majors', 'minors', 'core', 'academics', 'study-away'] },
  { title: 'Living here', ids: ['campus', 'housing', 'health', 'money', 'visa'] },
  { title: 'After NYUAD', ids: ['careers', 'research'] },
  { title: 'Rules and admissions', ids: ['admissions', 'policies'] },
  { title: 'The group', ids: ['threads'] },
];

/** The same map for a phone: each branch as a short line diagram rather than a shrunken drawing. */
function GuideLines({ counts, labels }: { counts: Map<string, number>; labels: Map<string, string> }) {
  return (
    <div className="gmap-list">
      {LINE_GROUPS.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <div className="stations">
            {group.ids
              .filter((id) => id === 'threads' || id === 'courses' || (counts.get(id) ?? 0) > 0)
              .map((id) => (
                <a key={id} href={`/guide/${id}`} className="stn" onClick={onLinkClick}>
                  <span className="what">{id === 'threads' ? 'Group threads' : (labels.get(id) ?? SHORT[id] ?? id)}</span>
                </a>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CourseList({ selected }: { selected?: string }) {
  const wide = useMedia(WIDE);
  const [items, setItems] = useState<GuideCourse[] | null>(null);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);
  useEffect(() => setLimit(PAGE_ROWS), [q, dept]);
  useEffect(() => {
    api.guide
      .courses()
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, []);
  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items ?? []) counts.set(item.department, (counts.get(item.department) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const needle = q.trim().toLowerCase();
  const squashed = needle.replace(/[^a-z0-9]/g, '');
  const shown = (items ?? []).filter((item) => (!dept || item.department === dept) && (!needle || item.code.toLowerCase().replace(/[^a-z0-9]/g, '').includes(squashed) || item.title.toLowerCase().includes(needle)));

  return (
    <div className="md">
      <div>
        <div className="toolbar">
          <div className="search-field" style={{ width: 'min(360px, 100%)' }}>
            <IconSearch />
            <input className="input" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Course code or title" aria-label="Filter courses" />
          </div>
        </div>
        <div className="chips scroll-x dept-strip">
          <button type="button" className={`chip${dept ? '' : ' on'}`} onClick={() => setDept('')}>
            All
          </button>
          {departments.slice(0, 30).map(([code]) => (
            <button key={code} type="button" className={`chip mono${dept === code ? ' on' : ''}`} onClick={() => setDept(dept === code ? '' : code)}>
              {code}
            </button>
          ))}
        </div>
        {!items && <div className="skeleton" style={{ height: 320 }} aria-busy="true" />}
        {items && shown.length === 0 && <div className="empty">No matching courses.</div>}
        {items && shown.length > 0 && (
          <div className="list">
            {shown.slice(0, limit).map((item) => (
              <a key={item.code} href={`/guide/courses/${encodeURIComponent(item.code)}`} className={`row course-row${selected === item.code ? ' on' : ''}`} onClick={onLinkClick}>
                <span className="code">{item.code}</span>
                <span className="grow">
                  <span className="title">{item.title || item.code}</span>
                </span>
                <IconChevronRight className="chev" />
              </a>
            ))}
          </div>
        )}
        {items && shown.length > limit && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => setLimit((current) => current + PAGE_ROWS * 2)}>
              Show more
            </button>
          </div>
        )}
      </div>
      <DetailSlot section="courses" id={selected} wide={wide}>
        <div className="pane-empty">
          <h2>Pick a course</h2>
        </div>
      </DetailSlot>
    </div>
  );
}

function SectionList({ section, label, selected }: { section: string; label: string; selected?: string }) {
  const { setAskPrefill } = useApp();
  const wide = useMedia(WIDE);
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
  const shown = (items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.parent.toLowerCase().includes(needle));
  return (
    <div className="md">
      <div>
        {error && <div className="alert error">{error}</div>}
        {items && items.length > 8 && (
          <div className="toolbar">
            <div className="search-field" style={{ width: 'min(360px, 100%)' }}>
              <IconSearch />
              <input className="input" value={q} onChange={(event) => setQ(event.target.value)} placeholder={`Filter ${label.toLowerCase()}`} aria-label="Filter pages" />
            </div>
          </div>
        )}
        {!items && !error && <div className="skeleton" style={{ height: 320 }} aria-busy="true" />}
        {items && shown.length === 0 && <div className="empty">No pages.</div>}
        {items && shown.length > 0 && (
          <div className="list">
            {shown.map((item) => (
              <a key={item.id} href={`/guide/${section}/${item.id}`} className={`row${selected === item.id ? ' on' : ''}`} onClick={onLinkClick}>
                <span className="grow">
                  <span className="title">{item.title}</span>
                  {item.parent && <span className="sub">{item.parent}</span>}
                </span>
                <IconChevronRight className="chev" />
              </a>
            ))}
          </div>
        )}
      </div>
      <DetailSlot section={section} id={selected} wide={wide}>
        <div className="pane-empty">
          <h2>Pick a page</h2>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAskPrefill({ question: `What should I know about ${label.toLowerCase()} at NYUAD?`, autoSend: true });
              navigate({ name: 'ask' });
            }}
          >
            Ask about {label.toLowerCase()}
          </button>
        </div>
      </DetailSlot>
    </div>
  );
}

/** On wide screens the entry sits in a pane beside the list; on narrow ones it slides in over it. */
function DetailSlot({ section, id, wide, children }: { section: string; id?: string; wide: boolean; children: ReactNode }) {
  const panel = usePresence(Boolean(id) && !wide, 220);
  const shownId = useLatest(id);
  const close = useCallback(() => navigate({ name: 'guide', section }, { keepScroll: true }), [section]);
  if (wide) {
    return <aside className="md-pane">{id ? <Detail key={id} section={section} id={id} onClose={close} /> : children}</aside>;
  }
  return panel.mounted && shownId ? <Drawer section={section} id={shownId} closing={panel.closing} onClose={close} /> : null;
}

function Drawer({ section, id, closing, onClose }: { section: string; id: string; closing: boolean; onClose(): void }) {
  useEffect(() => {
    if (closing) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, closing]);
  return createPortal(
    <div className={closing ? 'closing' : undefined} data-line="guide">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true">
        <Detail section={section} id={id} onClose={onClose} />
      </aside>
    </div>,
    document.body,
  );
}

function Detail({ section, id, onClose }: { section: string; id: string; onClose(): void }) {
  const { setAskPrefill } = useApp();
  const [detail, setDetail] = useState<GuideDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError('');
    (section === 'courses' ? api.guide.course(id) : api.guide.item(id))
      .then((result) => live && setDetail(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load this entry.'));
    return () => {
      live = false;
    };
  }, [section, id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ask = () => {
    if (!detail) return;
    setAskPrefill({ question: detail.kind === 'course' ? `What do students say about ${detail.code}?` : `What should I know about ${detail.title}?`, autoSend: true });
    navigate({ name: 'ask' });
  };

  // Course titles from the bulletin start with the code, which already sits above the title.
  const title = detail ? (detail.code && detail.title.startsWith(detail.code) ? detail.title.slice(detail.code.length).trim() || detail.title : detail.title) : section === 'courses' ? id : 'Loading';
  const crumbs = (detail?.breadcrumbs ?? []).filter((crumb) => crumb !== 'Home' && crumb !== title).slice(-2);
  return (
    <>
      <div className="pane-head">
        <div className="grow">
          <div className="crumbs">
            {detail?.code ? <span className="code">{detail.code}</span> : null}
            {crumbs.length > 0 && <span>{crumbs.join(' / ')}</span>}
          </div>
          <h2>{title}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>
      <div className="pane-body">
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
            <div className="detail-actions">
              <button type="button" className="btn sm primary" onClick={ask}>
                Ask about this
              </button>
              {detail.official && (
                <a className="btn sm" href={detail.official.url} target="_blank" rel="noreferrer">
                  <IconExternal /> Official page
                </a>
              )}
              {detail.official?.credits && <span className="tag">{detail.official.credits} credits</span>}
            </div>
            {detail.summary ? (
              <Summary summary={detail.summary} sources={detail.sources} />
            ) : (
              !detail.official && detail.threads.length === 0 && <p className="pane-note">Nothing here yet.</p>
            )}
            {detail.official && <OfficialText text={detail.official.text} code={detail.code} />}
            {detail.threads.length > 0 && (
              <>
                <h3 className="section-title">From the group</h3>
                <div>
                  {detail.threads.map((post) => (
                    <PostRow key={post.id} post={post} />
                  ))}
                </div>
              </>
            )}
            {detail.related && detail.related.length > 0 && (
              <>
                <h3 className="section-title">Related pages</h3>
                <div className="sources-list">
                  {detail.related.map((entry) => (
                    <a key={entry.id} href={`/guide/${detail.section}/${entry.id}`} onClick={onLinkClick}>
                      <IconChevronRight />
                      <span className="t">{entry.title}</span>
                    </a>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** The official page's own words, folded to a few lines until asked for. */
function OfficialText({ text, code }: { text: string; code?: string }) {
  const [open, setOpen] = useState(false);
  // Bulletin entries open with "CODE Title (4 credits)", which the pane header already shows.
  const body = code && text.startsWith(code) ? text.slice(text.indexOf('\n') + 1 || 0).trimStart() : text;
  const long = body.length > 700;
  return (
    <>
      <h3 className="section-title">Official text</h3>
      <div className={`official-text${long && !open ? ' folded' : ''}`}>{body}</div>
      {long && (
        <button type="button" className="link-btn small" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

function Summary({ summary, sources }: { summary: NonNullable<GuideDetail['summary']>; sources: GuideDetail['sources'] }) {
  const cite = (text: string) =>
    text.split(/(\[\d+(?:\]\[\d+)*\])/).map((part, index) => {
      if (!/^\[\d/.test(part)) return part;
      const numbers = [...new Set(part.match(/\d+/g) ?? [])];
      const shown = numbers.length > 3 ? numbers.slice(0, 2) : numbers;
      return [
        ...shown.map((n) => {
          const source = sources.find((entry) => entry.n === Number(n));
          return (
            <span key={`${index}-${n}`} className="cite" data-kind={source?.kind ?? 'archive'} title={source?.title}>
              {n}
            </span>
          );
        }),
        numbers.length > shown.length && (
          <span key={`${index}-more`} className="cite more" title={`Sources ${numbers.slice(shown.length).join(', ')}`}>
            +{numbers.length - shown.length}
          </span>
        ),
      ];
    });
  const sections: Array<[string, string[]]> = [
    ['From the official page', summary.facts],
    ['From students', summary.students],
    ['Keep in mind', summary.keepInMind],
  ];
  return (
    <div className="summary">
      <p className="overview">{cite(summary.overview)}</p>
      {sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => (
          <div key={heading}>
            <h3>{heading}</h3>
            <ul>
              {lines.map((line, i) => (
                <li key={i}>{cite(line)}</li>
              ))}
            </ul>
          </div>
        ))}
      {summary.confidence !== 'high' && (
        <div className="meta">
          <span className={`pill confidence ${summary.confidence}`}>
            <span className="dot" /> {CONFIDENCE_LABEL[summary.confidence]}
          </span>
        </div>
      )}
      {sources.length > 0 && (
        <div className="sources-list">
          {sources.map((source) => {
            const inner = (
              <>
                <span className="source-n">{source.n}</span>
                <span className="t">{source.title}</span>
                <span className="kind">{source.kind === 'official' ? 'Official' : source.kind === 'board' ? 'Student answer' : 'Thread'}</span>
              </>
            );
            if (source.kind === 'official')
              return (
                <a key={source.n} href={source.url} target="_blank" rel="noreferrer" data-kind={source.kind}>
                  {inner}
                </a>
              );
            return (
              <a key={source.n} href={source.kind === 'board' ? `/questions/${source.postId}` : `/post/${source.postId}`} onClick={onLinkClick} data-kind={source.kind}>
                {inner}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
