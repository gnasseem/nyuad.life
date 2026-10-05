import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, boardProblem as describeBoardProblem, type ChatGPTStatus, type Health, type Profile } from './api';
import { APP_NAME } from './brand';
import { Wordmark } from './components/Logo';
import { ProfileModal } from './components/ProfileForm';
import { AppContext, type Prefill, type ProfileRequest } from './context';
import { initials, relativeDate } from './format';
import { IconAsk, IconAuto, IconBag, IconBook, IconCalendar, IconClock, IconMegaphone, IconMoon, IconQuestions, IconSun, IconTrash, IconUser } from './icons';
import { AnnouncementsPage } from './pages/Announcements';
import { AskPage } from './pages/Ask';
import { CoursesPage } from './pages/Courses';
import { MarketPage } from './pages/Market';
import { PlanPage } from './pages/Plan';
import { PostPage } from './pages/Post';
import { QuestionPage, QuestionsPage } from './pages/Questions';
import { SettingsPage } from './pages/Settings';
import { navigate, onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, clearConversations, deleteConversation, loadActiveConversation, loadConversations, loadProfile, loadTheme, onConversationsChange, saveProfile, type Conversation, type Theme } from './store';
import { standingFor } from './year';

type Line = 'ask' | 'questions' | 'notices' | 'market' | 'guide' | 'plan';

const NAV: Array<{ route: Route; label: string; line: Line; icon: typeof IconAsk; matches: Route['name'][] }> = [
  { route: { name: 'ask' }, label: 'Ask', line: 'ask', icon: IconAsk, matches: ['ask'] },
  { route: { name: 'questions' }, label: 'Questions', line: 'questions', icon: IconQuestions, matches: ['questions', 'question'] },
  { route: { name: 'announcements' }, label: 'Notices', line: 'notices', icon: IconMegaphone, matches: ['announcements'] },
  { route: { name: 'market', tab: 'items' }, label: 'Market', line: 'market', icon: IconBag, matches: ['market'] },
  { route: { name: 'courses' }, label: 'Courses', line: 'guide', icon: IconBook, matches: ['courses', 'threads', 'post'] },
  { route: { name: 'plan' }, label: 'Plan', line: 'plan', icon: IconCalendar, matches: ['plan'] },
];

const THEME_LABEL: Record<Theme, string> = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
const PAGE_TITLE: Partial<Record<Route['name'], string>> = { questions: 'Questions', question: 'Question', announcements: 'Notices', market: 'Market', courses: 'Courses', threads: 'Threads', post: 'Thread', plan: 'Plan', settings: 'Settings' };
const DEFAULT_PROFILE_REQUEST = { title: 'Your details', reason: '' };

function useConversations(): Conversation[] {
  const [items, setItems] = useState(loadConversations);
  useEffect(() => onConversationsChange(() => setItems(loadConversations())), []);
  return items;
}

/** The conversation open on Ask in this tab; the Ask links lead back to it until "New question". */
function useActiveConversation(): string | null {
  const [active, setActive] = useState(loadActiveConversation);
  useEffect(() => onConversationsChange(() => setActive(loadActiveConversation())), []);
  return active;
}

export function App() {
  const { route, search } = useRoute();
  const [health, setHealth] = useState<Health | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(loadProfile);
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  const [toastState, setToastState] = useState<{ message: string; leaving: boolean; id: number } | null>(null);
  const [askPrefill, setAskPrefillState] = useState<(Prefill & { token: number }) | null>(null);
  const [boardPrefill, setBoardPrefill] = useState('');
  const [chatgpt, setChatGPT] = useState<ChatGPTStatus | null>(null);
  const [history, setHistory] = useState(false);
  const [profileAsk, setProfileAsk] = useState<{ title: string; reason: string } | null>(null);
  const profileRequest = useRef<((saved: boolean) => void) | null>(null);
  const conversations = useConversations();
  const active = useActiveConversation();
  const askHref = active ? `/?c=${encodeURIComponent(active)}` : '/';
  const hrefOf = (target: Route) => (target.name === 'ask' ? askHref : routePath(target));

  // Class years roll over on 1 May; the stored standing is brought up to date so the board routes correctly.
  useEffect(() => {
    if (!profile) return;
    const current = standingFor(profile.classOf);
    if (current === profile.year) return;
    const next = { ...profile, year: current };
    saveProfile(next);
    setProfileState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, gemini: { configured: false }, board: { configured: false } }));
  }, []);

  const refreshChatGPT = useCallback(() => {
    api.chatgpt
      .me()
      .then(setChatGPT)
      .catch(() => setChatGPT({ available: false, required: false, connected: false, name: '', email: '', plan: '' }));
  }, []);
  useEffect(refreshChatGPT, [refreshChatGPT]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setHistory(false);
  }, [route, search]);

  useEffect(() => {
    const title = PAGE_TITLE[route.name];
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [route.name]);

  const activeIndex = NAV.findIndex((item) => item.matches.includes(route.name));
  const line: Line = NAV[activeIndex]?.line ?? 'ask';
  useEffect(() => {
    document.documentElement.dataset.line = line;
  }, [line]);

  const toastTimers = useRef<number[]>([]);
  const toast = useCallback((message: string) => {
    toastTimers.current.forEach((timer) => window.clearTimeout(timer));
    const id = Date.now();
    setToastState({ message, leaving: false, id });
    toastTimers.current = [window.setTimeout(() => setToastState((current) => (current?.id === id ? { ...current, leaving: true } : current)), 1900), window.setTimeout(() => setToastState((current) => (current?.id === id ? null : current)), 2100)];
  }, []);

  const setAskPrefill = useCallback((prefill: Prefill | null) => {
    setAskPrefillState(prefill ? { ...prefill, token: Date.now() } : null);
  }, []);

  const setProfile = useCallback((next: Profile | null) => {
    saveProfile(next);
    setProfileState(next);
  }, []);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  const requestProfile = useCallback(
    (request: ProfileRequest = {}) =>
      new Promise<boolean>((resolve) => {
        profileRequest.current?.(false);
        profileRequest.current = resolve;
        setProfileAsk({ title: request.title ?? DEFAULT_PROFILE_REQUEST.title, reason: request.reason ?? DEFAULT_PROFILE_REQUEST.reason });
      }),
    [],
  );

  const finishProfile = (saved: boolean) => {
    setProfileAsk(null);
    profileRequest.current?.(saved);
    profileRequest.current = null;
  };

  const boardProblem = useMemo(() => describeBoardProblem(health), [health]);

  // Back from ChatGPT: say how it went once, and take the marker out of the address.
  useEffect(() => {
    const result = search.get('chatgpt');
    if (!result) return;
    const reason = search.get('reason') ?? '';
    toast(result === 'connected' ? 'ChatGPT connected. Answers now run on your plan.' : reason === 'chatgpt_denied' ? 'ChatGPT was not connected.' : 'Could not connect ChatGPT. Try again.');
    const url = new URL(window.location.href);
    url.searchParams.delete('chatgpt');
    url.searchParams.delete('reason');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const context = useMemo(
    () => ({ health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, setBoardPrefill, chatgpt, refreshChatGPT }),
    [health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, chatgpt, refreshChatGPT],
  );

  const cycleTheme = () => setThemeState(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconAuto;
  const currentConversation = route.name === 'ask' ? search.get('c') : null;

  const page = (() => {
    switch (route.name) {
      case 'questions':
        return <QuestionsPage search={search} />;
      case 'question':
        return <QuestionPage id={route.id} />;
      case 'announcements':
        return <AnnouncementsPage />;
      case 'market':
        return <MarketPage tab={route.tab} />;
      case 'courses':
        return <CoursesPage view="courses" code={route.code} />;
      case 'threads':
        return <CoursesPage view="threads" />;
      case 'plan':
        return <PlanPage />;
      case 'post':
        return <PostPage id={route.id} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <AskPage resumeId={currentConversation ?? undefined} />;
    }
  })();

  // A new key per page replays its entrance. Market tabs and a course opening beside the list keep the key, so they do not.
  const pageKey = route.name === 'market' ? 'market' : route.name === 'courses' || route.name === 'threads' ? 'courses' : routePath(route);
  const settingsActive = route.name === 'settings';

  const me = (
    <button type="button" className="me-btn" onClick={() => (profile ? navigate({ name: 'settings' }) : void requestProfile())} title={profile ? `${profile.name}, settings` : 'Add your details'} aria-label={profile ? 'Settings' : 'Add your details'}>
      {profile ? (
        <span className="avatar">{initials(profile.name)}</span>
      ) : (
        <span className="avatar plain">
          <IconUser style={{ width: 15, height: 15 }} />
        </span>
      )}
    </button>
  );

  return (
    <AppContext.Provider value={context}>
      <div className="app">
        <div className="ground" aria-hidden="true" />
        <header className="appbar">
          <a href={askHref} className="brand" onClick={onLinkClick} aria-label={`${APP_NAME}, home`}>
            <Wordmark />
          </a>
          <LineNav activeIndex={activeIndex} hrefOf={hrefOf} />
          <div className="bar-tools">
            <HistoryMenu open={history} setOpen={setHistory} conversations={conversations} current={currentConversation} />
            <button type="button" className="icon-btn" onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon key={theme} className="turn-in" />
            </button>
            <span className={settingsActive ? 'is-settings' : undefined}>{me}</span>
          </div>
        </header>

        <main className="main" key={pageKey}>
          <ErrorBoundary>{page}</ErrorBoundary>
        </main>

        <nav className="tabbar" aria-label="Sections">
          {NAV.map((item, index) => (
            <a key={item.label} href={hrefOf(item.route)} data-line={item.line} aria-current={index === activeIndex ? 'page' : undefined} onClick={onLinkClick}>
              <item.icon />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
      </div>
      {toastState && (
        <div key={toastState.id} className={`toast${toastState.leaving ? ' leaving' : ''}`} role="status">
          {toastState.message}
        </div>
      )}
      <ProfileModal open={profileAsk !== null} title={profileAsk?.title ?? ''} reason={profileAsk?.reason ?? ''} onClose={() => finishProfile(false)} onDone={() => finishProfile(true)} />
    </AppContext.Provider>
  );
}

/** The six lines as tabs, with one enamel plate that slides to the line you are on and takes its colour. */
function LineNav({ activeIndex, hrefOf }: { activeIndex: number; hrefOf(route: Route): string }) {
  const ref = useRef<HTMLElement>(null);
  const [plate, setPlate] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const active = element.querySelector<HTMLElement>('[aria-current="page"]');
      setPlate(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [activeIndex]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <nav ref={ref} className="lines" aria-label="Sections">
      <span
        className="lines-plate"
        style={{ transform: `translateX(${plate?.x ?? 0}px)`, width: plate?.w ?? 0, opacity: plate ? 1 : 0, transition: ready ? undefined : 'none' }}
        aria-hidden="true"
      >
        <i key={activeIndex} className="shine" />
      </span>
      {NAV.map((item, index) => (
        <a key={item.label} href={hrefOf(item.route)} className="line-tab" data-line={item.line} aria-current={index === activeIndex ? 'page' : undefined} onClick={onLinkClick}>
          <span className="swatch" />
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function HistoryMenu({ open, setOpen, conversations, current }: { open: boolean; setOpen(open: boolean): void; conversations: Conversation[]; current: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  const remove = (id: string) => {
    deleteConversation(id);
    if (current === id) navigate({ name: 'ask' });
  };

  const clearAll = () => {
    if (!window.confirm('Delete all saved conversations?')) return;
    clearConversations();
    setOpen(false);
    if (current) navigate({ name: 'ask' });
  };

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" title="Your questions" aria-label="Your questions">
        <IconClock />
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Your questions">
          <div className="popover-head">
            <span className="label">Your questions</span>
            {conversations.length > 0 && (
              <button type="button" className="btn ghost sm" onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>
          {conversations.length === 0 ? (
            <p className="popover-empty">No questions yet.</p>
          ) : (
            conversations.slice(0, 40).map((conversation) => (
              <div key={conversation.id} className={`hist-item${current === conversation.id ? ' active' : ''}`}>
                <a href={`/?c=${conversation.id}`} onClick={onLinkClick} title={conversation.title}>
                  <b>{conversation.title}</b>
                  <span>{relativeDate(conversation.updatedAt)}</span>
                </a>
                <button type="button" onClick={() => remove(conversation.id)} aria-label="Delete conversation">
                  <IconTrash />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Keeps one broken page from blanking the whole site. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <div className="alert error">
          <b>This page hit a problem.</b>
          Reload to try again.
        </div>
      </div>
    );
  }
}
