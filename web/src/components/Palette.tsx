import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type GuideCourse, type GuideSection, type PostSummary } from '../api';
import { useApp } from '../context';
import { formatDate, plural, relativeDate } from '../format';
import { IconAsk, IconChat, IconClock, IconMoon, IconSearch, IconSun } from '../icons';
import { navigate, type Route } from '../router';
import { loadConversations } from '../store';

export interface SearchItem {
  id: string;
  group: string;
  title: ReactNode;
  hint?: string;
  line: string;
  icon?: ReactNode;
  code?: string;
  run(): void;
}

const PLACES: Array<{ title: string; line: string; route: Route; search?: string; words: string }> = [
  { title: 'Ask', line: 'ask', route: { name: 'ask' }, words: 'ask question answer home central' },
  { title: 'Ask students', line: 'questions', route: { name: 'questions' }, words: 'questions ask students board post' },
  { title: 'Answer questions', line: 'questions', route: { name: 'questions' }, search: 'tab=help', words: 'answer help questions flashcards leaderboard' },
  { title: 'Notices', line: 'notices', route: { name: 'announcements' }, words: 'notices events deadlines announcements calendar clubs' },
  { title: 'For sale, wanted and free', line: 'market', route: { name: 'market', tab: 'items' }, words: 'market sell buy for sale wanted free listings' },
  { title: 'Falcons', line: 'market', route: { name: 'market', tab: 'falcons' }, words: 'falcons dirhams exchange rate buy sell meal' },
  { title: 'Rides', line: 'market', route: { name: 'market', tab: 'rides' }, words: 'rides taxi careem airport dubai share' },
  { title: 'Lost and found', line: 'market', route: { name: 'market', tab: 'lost' }, words: 'lost found missing' },
  { title: 'Guide', line: 'guide', route: { name: 'guide' }, words: 'guide map official pages' },
  { title: 'Group threads', line: 'guide', route: { name: 'guide', section: 'threads' }, words: 'threads archive group facebook room of requirement search' },
  { title: 'Courses', line: 'guide', route: { name: 'guide', section: 'courses' }, words: 'courses bulletin classes catalog' },
  { title: 'Settings', line: 'ask', route: { name: 'settings' }, words: 'settings theme details profile data' },
];

function score(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  if (!needle) return 1;
  if (text.startsWith(needle)) return 4;
  if (text.includes(` ${needle}`)) return 3;
  if (text.includes(needle)) return 2;
  return 0;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Everything a search box can take you to: places, guide sections, courses, past conversations and, optionally, threads. */
export function useSearchItems(query: string, done: () => void, options: { threads?: boolean } = {}): SearchItem[] {
  const { setAskPrefill, theme, setTheme } = useApp();
  const [sections, setSections] = useState<GuideSection[]>([]);
  const [courses, setCourses] = useState<GuideCourse[]>([]);
  const [threads, setThreads] = useState<PostSummary[]>([]);
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    api.guide
      .sections()
      .then((result) => setSections(result.sections))
      .catch(() => setSections([]));
    api.guide
      .courses()
      .then((result) => setCourses(result.items))
      .catch(() => setCourses([]));
  }, []);

  useEffect(() => {
    if (!options.threads || needle.length < 3) {
      setThreads([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .search({ q: needle })
        .then((result) => live && setThreads(result.results.slice(0, 4)))
        .catch(() => live && setThreads([]));
    }, 260);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [needle, options.threads]);

  return useMemo(() => {
    const go = (route: Route, search?: string) => () => {
      done();
      navigate(route, search ? { search } : {});
    };
    const items: SearchItem[] = [];
    if (needle) {
      const question = query.trim();
      items.push({ id: 'ask', group: 'Ask', title: <q>{question}</q>, hint: 'Ask', line: 'ask', icon: <IconAsk />, run: () => {
        done();
        setAskPrefill({ question, autoSend: true });
        navigate({ name: 'ask' });
      } });
      items.push({ id: 'threads', group: 'Ask', title: <>Search the group for <q>{question}</q></>, hint: 'Threads', line: 'guide', icon: <IconSearch />, run: go({ name: 'guide', section: 'threads' }, `q=${encodeURIComponent(question)}`) });
    }

    const places = PLACES.map((place) => ({ place, s: Math.max(score(place.title, needle), score(place.words, needle) ? 1 : 0) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, needle ? 4 : PLACES.length);
    for (const { place } of places) items.push({ id: `place-${place.title}`, group: 'Go to', title: place.title, line: place.line, run: go(place.route, place.search) });

    if (needle) {
      const sectionHits = sections.filter((section) => section.count > 0 && score(section.label, needle) > 0).slice(0, 4);
      for (const section of sectionHits) items.push({ id: `section-${section.id}`, group: 'Guide', title: section.label, hint: plural(section.count, section.id === 'courses' ? 'course' : 'page'), line: 'guide', run: go({ name: 'guide', section: section.id }) });

      const squashed = squash(needle);
      const courseHits = courses
        .map((course) => ({ course, s: squashed.length >= 2 && squash(course.code).startsWith(squashed) ? 5 : score(course.title, needle) }))
        .filter((entry) => entry.s > 0)
        .sort((a, b) => b.s - a.s || b.course.threads - a.course.threads)
        .slice(0, 6);
      for (const { course } of courseHits) items.push({ id: `course-${course.code}`, group: 'Courses', title: course.title || 'Mentioned in the group', code: course.code, hint: course.threads ? plural(course.threads, 'thread') : undefined, line: 'guide', run: go({ name: 'guide', section: 'courses', id: course.code }) });

      for (const post of threads) items.push({ id: `post-${post.id}`, group: 'From the group', title: post.preview.replace(/\s+/g, ' ').slice(0, 110), hint: formatDate(post.date), line: 'guide', icon: <IconChat />, run: go({ name: 'post', id: post.id }) });
    }

    const conversations = loadConversations()
      .filter((conversation) => !needle || score(conversation.title, needle) > 0)
      .slice(0, needle ? 4 : 5);
    for (const conversation of conversations) items.push({ id: `c-${conversation.id}`, group: needle ? 'Your questions' : 'Recent', title: conversation.title, hint: relativeDate(conversation.updatedAt), line: 'ask', icon: <IconClock />, run: go({ name: 'ask' }, `c=${conversation.id}`) });

    if (!needle || score('night day theme dark light service', needle) > 0) {
      const next = theme === 'dark' ? 'light' : 'dark';
      items.push({ id: 'theme', group: 'Settings', title: next === 'dark' ? 'Switch to night service' : 'Switch to day service', line: 'ask', icon: next === 'dark' ? <IconMoon /> : <IconSun />, run: () => {
        setTheme(next);
        done();
      } });
    }
    return items;
  }, [needle, query, sections, courses, threads, theme, done, setAskPrefill, setTheme]);
}

/** Moves a highlighted index through results with the arrow keys and runs the highlighted one on Enter. */
export function useListKeys(items: SearchItem[], onEscape?: () => void) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items.length, items[0]?.id]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(items.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      items[active]?.run();
    } else if (event.key === 'Escape') onEscape?.();
  };
  return { active, setActive, onKeyDown };
}

export function SearchList({ items, active, setActive }: { items: SearchItem[]; active: number; setActive(index: number): void }) {
  useEffect(() => {
    document.getElementById(`si-${items[active]?.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);
  let group = '';
  return (
    <div className="palette-list" role="listbox">
      {items.map((item, index) => {
        const head = item.group !== group ? <div className="palette-group">{(group = item.group)}</div> : null;
        return (
          <div key={item.id}>
            {head}
            <button
              id={`si-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className="palette-item"
              data-line={item.line}
              onMouseMove={() => index !== active && setActive(index)}
              onClick={() => item.run()}
            >
              <span className={`pi${item.icon ? '' : ' line-chip'}`}>{item.icon}</span>
              {item.code && <span className="code">{item.code}</span>}
              <span className="pt">{item.title}</span>
              {item.hint && <span className="ph">{item.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** ⌘K: one box that goes anywhere, asks anything, or finds a course. */
export function Palette({ open, onClose }: { open: boolean; onClose(): void }) {
  if (!open) return null;
  return createPortal(<PaletteBody onClose={onClose} />, document.body);
}

function PaletteBody({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useSearchItems(query, onClose);
  const { active, setActive, onKeyDown } = useListKeys(items, onClose);

  useEffect(() => {
    inputRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div className="palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Where to?">
        <div className="palette-input">
          <IconSearch />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Where to? Ask, or find a course, a page, a ride" aria-label="Where to?" role="combobox" aria-expanded="true" />
          <kbd>esc</kbd>
        </div>
        {items.length ? <SearchList items={items} active={active} setActive={setActive} /> : <div className="palette-empty">Nothing matches.</div>}
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> go
          </span>
          <span>
            <kbd>G</kbd> then <kbd>A</kbd>
            <kbd>Q</kbd>
            <kbd>N</kbd>
            <kbd>M</kbd>
            <kbd>G</kbd> jumps to a line
          </span>
        </div>
      </div>
    </div>
  );
}
