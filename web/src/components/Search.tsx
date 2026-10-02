import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type GuideCourse, type GuideSection, type PostSummary } from '../api';
import { useApp } from '../context';
import { formatDate, relativeDate } from '../format';
import { IconAsk, IconChat, IconClock, IconSearch } from '../icons';
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

function score(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  if (!needle) return 1;
  if (text.startsWith(needle)) return 4;
  if (text.includes(` ${needle}`)) return 3;
  if (text.includes(needle)) return 2;
  return 0;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Everything the guide's search box can take you to: Ask, guide sections, courses, past conversations and, optionally, threads. */
export function useSearchItems(query: string, done: () => void, options: { threads?: boolean } = {}): SearchItem[] {
  const { setAskPrefill } = useApp();
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
      items.push({ id: 'threads', group: 'Ask', title: <>Search threads for <q>{question}</q></>, hint: 'Threads', line: 'guide', icon: <IconSearch />, run: go({ name: 'guide', section: 'threads' }, `q=${encodeURIComponent(question)}`) });
    }

    if (needle) {
      const sectionHits = sections.filter((section) => section.count > 0 && score(section.label, needle) > 0).slice(0, 4);
      for (const section of sectionHits) items.push({ id: `section-${section.id}`, group: 'Guide', title: section.label, line: 'guide', run: go({ name: 'guide', section: section.id }) });

      const squashed = squash(needle);
      const courseHits = courses
        .map((course) => ({ course, s: squashed.length >= 2 && squash(course.code).startsWith(squashed) ? 5 : score(course.title, needle) }))
        .filter((entry) => entry.s > 0)
        .sort((a, b) => b.s - a.s || b.course.threads - a.course.threads)
        .slice(0, 6);
      for (const { course } of courseHits) items.push({ id: `course-${course.code}`, group: 'Courses', title: course.title || course.code, code: course.code, line: 'guide', run: go({ name: 'guide', section: 'courses', id: course.code }) });

      for (const post of threads) items.push({ id: `post-${post.id}`, group: 'From the group', title: post.preview.replace(/\s+/g, ' ').slice(0, 110), hint: formatDate(post.date), line: 'guide', icon: <IconChat />, run: go({ name: 'post', id: post.id }) });
    }

    const conversations = needle ? loadConversations().filter((conversation) => score(conversation.title, needle) > 0).slice(0, 4) : [];
    for (const conversation of conversations) items.push({ id: `c-${conversation.id}`, group: 'Your questions', title: conversation.title, hint: relativeDate(conversation.updatedAt), line: 'ask', icon: <IconClock />, run: go({ name: 'ask' }, `c=${conversation.id}`) });

    return items;
  }, [needle, query, sections, courses, threads, done, setAskPrefill]);
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
    <div className="search-list" role="listbox">
      {items.map((item, index) => {
        const head = item.group !== group ? <div className="search-group">{(group = item.group)}</div> : null;
        return (
          <div key={item.id}>
            {head}
            <button
              id={`si-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className="search-item"
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
