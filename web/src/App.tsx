import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, boardProblem as describeBoardProblem, onSignupRequired, type ChatGPTStatus, type Health, type Profile } from './api';
import { APP_NAME } from './brand';
import { HistoryPanel } from './components/HistoryPanel';
import { Wordmark } from './components/Logo';
import { ProfileModal } from './components/ProfileForm';
import { AppContext, type Prefill, type ProfileRequest } from './context';
import { initials } from './format';
import { IconAsk, IconBag, IconBook, IconCalendar, IconMegaphone, IconMoon, IconQuestions, IconShield, IconSun, IconUser } from './icons';
import { AskPage } from './pages/Ask';
import { navigate, onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, loadActiveConversation, loadConversations, loadOnboarded, loadProfile, loadSidebarClosed, loadTheme, onConversationsChange, saveOnboarded, saveAccountKey, saveProfile, saveSidebarClosed, type Conversation, type Theme } from './store';
import { standingFor } from './year';

type Line = 'ask' | 'questions' | 'notices' | 'market' | 'guide' | 'plan';

// Ask is the page most visits open on, so it ships with the app; the others load when first opened, and are fetched
// in the background once the first screen is up so that opening them later is instant.
const loaders = {
  plan: () => import('./pages/Plan'),
  courses: () => import('./pages/Courses'),
  questions: () => import('./pages/Questions'),
  events: () => import('./pages/Announcements'),
  market: () => import('./pages/Market'),
  post: () => import('./pages/Post'),
  threads: () => import('./pages/Threads'),
  settings: () => import('./pages/Settings'),
  welcome: () => import('./components/Welcome'),
};
const PlanPage = lazy(() => loaders.plan().then((module) => ({ default: module.PlanPage })));
const CoursesPage = lazy(() => loaders.courses().then((module) => ({ default: module.CoursesPage })));
const QuestionsPage = lazy(() => loaders.questions().then((module) => ({ default: module.QuestionsPage })));
const QuestionPage = lazy(() => loaders.questions().then((module) => ({ default: module.QuestionPage })));
const AnnouncementsPage = lazy(() => loaders.events().then((module) => ({ default: module.AnnouncementsPage })));
const MarketPage = lazy(() => loaders.market().then((module) => ({ default: module.MarketPage })));
const PostPage = lazy(() => loaders.post().then((module) => ({ default: module.PostPage })));
const ThreadSearch = lazy(() => loaders.threads().then((module) => ({ default: module.ThreadSearch })));
const SettingsPage = lazy(() => loaders.settings().then((module) => ({ default: module.SettingsPage })));
const Welcome = lazy(() => loaders.welcome().then((module) => ({ default: module.Welcome })));

function prefetchPages(): void {
  const run = () => Object.values(loaders).forEach((load) => void load().catch(() => undefined));
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4_000 });
  else window.setTimeout(run, 2_000);
}

const NAV: Array<{ route: Route; label: string; line: Line; icon: typeof IconAsk; matches: Route['name'][] }> = [
  { route: { name: 'ask' }, label: 'Ask', line: 'ask', icon: IconAsk, matches: ['ask'] },
  { route: { name: 'plan' }, label: 'Plan', line: 'plan', icon: IconCalendar, matches: ['plan'] },
  { route: { name: 'courses' }, label: 'Reviews', line: 'guide', icon: IconBook, matches: ['courses', 'professors', 'threads', 'post'] },
  { route: { name: 'questions' }, label: 'Questions', line: 'questions', icon: IconQuestions, matches: ['questions', 'question'] },
  { route: { name: 'announcements' }, label: 'Events', line: 'notices', icon: IconMegaphone, matches: ['announcements'] },
  { route: { name: 'market', tab: 'items' }, label: 'Market', line: 'market', icon: IconBag, matches: ['market'] },
];

/** The button names what it switches to. */
const THEME_LABEL: Record<Theme, string> = { light: 'Switch to dark mode', dark: 'Switch to light mode' };
const PAGE_TITLE: Partial<Record<Route['name'], string>> = { questions: 'Questions', question: 'Question', announcements: 'Events', market: 'Market', courses: 'Reviews', professors: 'Professors', threads: 'Threads', post: 'Thread', plan: 'Plan', settings: 'Settings' };
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
  const [admin, setAdmin] = useState(false);
  // On a wide screen the conversation list stays open unless folded away; on a phone it opens on demand.
  const wide = () => window.matchMedia('(min-width: 1100px)').matches;
  const [panelOpen, setPanelOpen] = useState(() => wide() && loadConversations().length > 0 && !loadSidebarClosed());
  const [onboarded, setOnboarded] = useState(loadOnboarded);
  /** Set when the server no longer knows this browser's details: the sign-up form comes back, with why. */
  const [resignup, setResignup] = useState(false);
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

  const refreshAdmin = useCallback(() => {
    api.admin
      .me()
      .then((result) => setAdmin(result.admin))
      .catch(() => setAdmin(false));
  }, []);
  useEffect(refreshAdmin, [refreshAdmin, profile]);
  useEffect(() => {
    void api.auth.me().then((result) => {
      if (result.profile) { saveAccountKey(result.key); setProfileState(result.profile); saveProfile(result.profile); }
      else if (profile) setResignup(true);
    }).catch(() => { if (profile) setResignup(true); });
  }, []);

  useEffect(() => onSignupRequired(() => setResignup(true)), []);
  useEffect(prefetchPages, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Crossing from a phone-sized window to a wide one (or back) puts the list where that size expects it.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1100px)');
    const onChange = () => setPanelOpen(query.matches && loadConversations().length > 0 && !loadSidebarClosed());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

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

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next, true);
    setThemeState(next);
  }, []);

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
    () => ({ health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, setBoardPrefill, chatgpt, refreshChatGPT, admin, refreshAdmin }),
    [health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, chatgpt, refreshChatGPT, admin, refreshAdmin],
  );

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const ThemeIcon = theme === 'dark' ? IconMoon : IconSun;
  const currentConversation = route.name === 'ask' ? search.get('c') : null;
  const onAsk = route.name === 'ask';
  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    if (wide()) saveSidebarClosed(!next);
  };
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    if (window.matchMedia('(min-width: 1100px)').matches) saveSidebarClosed(true);
  }, []);
  const gate = !profile || resignup;

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
      case 'professors':
        return <CoursesPage view="professors" professor={route.nameQuery} />;
      case 'threads':
        return <ThreadSearch />;
      case 'plan':
        return <PlanPage />;
      case 'post':
        return <PostPage id={route.id} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <AskPage resumeId={currentConversation ?? undefined} history={{ open: panelOpen, count: conversations.length, toggle: togglePanel }} />;
    }
  })();

  // A new key per page replays its entrance. Market tabs and a course opening beside the list keep the key, so they do not.
  const pageKey = route.name === 'market' ? 'market' : route.name === 'courses' || route.name === 'professors' ? 'reviews' : routePath(route);
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
      <div className={`app${onAsk ? ' on-ask' : ''}`} data-panel={onAsk && panelOpen ? 'open' : 'closed'}>
        <div className="ground" aria-hidden="true" />
        <header className="appbar">
          <div className="bar-start">
            <a href={askHref} className="brand" onClick={onLinkClick} aria-label={`${APP_NAME}, home`}>
              <Wordmark />
            </a>
          </div>
          <LineNav activeIndex={activeIndex} hrefOf={hrefOf} />
          <div className="bar-tools">
            {admin && (
              <a href="/settings#admin" className="admin-badge" onClick={onLinkClick} title="Admin mode is on">
                <IconShield /> <span>Admin</span>
              </a>
            )}
            <button type="button" className="icon-btn" onClick={toggleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon key={theme} className="turn-in" />
            </button>
            <span className={settingsActive ? 'is-settings' : undefined}>{me}</span>
          </div>
        </header>

        <main className="main" key={pageKey}>
          {onAsk ? (
            <div className="ask-shell">
              <HistoryPanel conversations={conversations} current={currentConversation} open={panelOpen} onClose={closePanel} />
              <div className="ask-body">
                <ErrorBoundary>{page}</ErrorBoundary>
              </div>
            </div>
          ) : (
            <ErrorBoundary>
              <Suspense fallback={<PageLoading />}>{page}</Suspense>
            </ErrorBoundary>
          )}
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
      <ProfileModal open={profileAsk !== null && !gate} title={profileAsk?.title ?? ''} reason={profileAsk?.reason ?? ''} onClose={() => finishProfile(false)} onDone={() => finishProfile(true)} />
      {gate && (
        <Suspense fallback={null}>
          <Welcome
            tour={!onboarded && !resignup}
            reason={resignup && profile ? 'Verify your NYU email to log in on this device.' : undefined}
            onToured={() => {
              saveOnboarded();
              setOnboarded(true);
            }}
            onDone={(saved) => {
              saveOnboarded();
              setOnboarded(true);
              setResignup(false);
              setProfile(saved);
              toast(`Welcome aboard, ${saved.name.split(' ')[0]}`);
            }}
          />
        </Suspense>
      )}
    </AppContext.Provider>
  );
}

/** The six sections as tabs, with one plate that slides to the one you are on and takes its colour. */
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

/** What a page shows for the moment its code is still arriving. */
function PageLoading() {
  return (
    <div className="page" aria-busy="true">
      <div className="skeleton" style={{ height: 40, width: 220, marginBottom: 24 }} />
      <div className="skeleton" style={{ height: 320 }} />
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
