import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, boardProblem as describeBoardProblem, type Health, type HomePayload, type Profile } from './api';
import { Celebration } from './components/Celebration';
import { Wordmark } from './components/Logo';
import { ProfileModal } from './components/ProfileForm';
import { Welcome } from './components/Welcome';
import { AppContext, type Prefill, type ProfileRequest } from './context';
import { initials, standingLabel } from './format';
import { IconArchive, IconAsk, IconAuto, IconClose, IconMegaphone, IconMenu, IconMoon, IconQuestions, IconSettings, IconSun, IconTrash, IconUser } from './icons';
import { AnnouncementsPage } from './pages/Announcements';
import { AskPage } from './pages/Ask';
import { BrowsePage } from './pages/Browse';
import { CoursesPage } from './pages/Courses';
import { PostPage } from './pages/Post';
import { QuestionPage, QuestionsPage } from './pages/Questions';
import { SettingsPage } from './pages/Settings';
import { navigate, onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, clearConversations, deleteConversation, hasBeenWelcomed, loadConversations, loadProfile, loadTheme, markWelcomed, onConversationsChange, saveProfile, type Conversation, type Theme } from './store';
import { promotionMessage, standingFor } from './year';

const NAV: Array<{ route: Route; label: string; short: string; icon: typeof IconAsk; matches: Route['name'][] }> = [
  { route: { name: 'ask' }, label: 'Ask', short: 'Ask', icon: IconAsk, matches: ['ask'] },
  { route: { name: 'questions' }, label: 'Questions', short: 'Questions', icon: IconQuestions, matches: ['questions', 'question'] },
  { route: { name: 'announcements' }, label: 'What\u2019s on', short: 'What’s on', icon: IconMegaphone, matches: ['announcements'] },
  { route: { name: 'browse' }, label: 'Archive', short: 'Archive', icon: IconArchive, matches: ['browse', 'post', 'courses'] },
];

const THEME_LABEL: Record<Theme, string> = { system: 'Theme follows your system', light: 'Light theme', dark: 'Dark theme' };
const DEFAULT_PROFILE_REQUEST = { title: 'Who are you?', reason: 'Your major and year route the right questions to you, and your name goes next to what you write. One time only.' };

function useConversations(): Conversation[] {
  const [items, setItems] = useState(loadConversations);
  useEffect(() => onConversationsChange(() => setItems(loadConversations())), []);
  return items;
}

export function App() {
  const { route, search } = useRoute();
  const [home, setHome] = useState<HomePayload | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(loadProfile);
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  const [toastMessage, setToastMessage] = useState('');
  const [askPrefill, setAskPrefillState] = useState<(Prefill & { token: number }) | null>(null);
  const [boardPrefill, setBoardPrefill] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [moment, setMoment] = useState<{ title: string; message: string; action?: string } | null>(null);
  const [profileAsk, setProfileAsk] = useState<{ title: string; reason: string } | null>(null);
  const [welcome, setWelcome] = useState(false);
  const profileRequest = useRef<((saved: boolean) => void) | null>(null);
  const conversations = useConversations();

  // Every 1 May the class years roll over: say so once, and keep the stored standing current for the board.
  useEffect(() => {
    if (!profile) return;
    const current = standingFor(profile.classOf);
    if (current === profile.year) return;
    const promotion = promotionMessage(profile.year, current);
    const next = { ...profile, year: current };
    saveProfile(next);
    setProfileState(next);
    if (promotion) setMoment(promotion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api
      .home()
      .then(setHome)
      .catch(() => setHome(null));
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, gemini: { configured: false }, board: { configured: false } }));
  }, []);

  // The welcome sheet: once per device, a moment after the page settles, only for people we do not know yet.
  useEffect(() => {
    if (profile || hasBeenWelcomed()) return;
    const timer = window.setTimeout(() => setWelcome(true), 700);
    return () => window.clearTimeout(timer);
  }, [profile]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setDrawer(false);
  }, [route, search]);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(''), 1800);
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

  const finishWelcome = (saved: boolean) => {
    markWelcomed();
    setWelcome(false);
    if (saved) toast('Welcome aboard');
  };

  const celebrate = useCallback((next: { title: string; message: string; action?: string }) => setMoment(next), []);
  const boardProblem = useMemo(() => describeBoardProblem(health), [health]);

  const context = useMemo(
    () => ({ home, health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, setBoardPrefill, celebrate }),
    [home, health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, celebrate],
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
      case 'browse':
        return <BrowsePage key="browse" search={search} />;
      case 'post':
        return <PostPage id={route.id} />;
      case 'courses':
        return <CoursesPage code={route.code} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <AskPage resumeId={currentConversation ?? undefined} />;
    }
  })();

  const clearAll = () => {
    if (!window.confirm('Delete every saved conversation on this device?')) return;
    clearConversations();
    if (currentConversation) navigate({ name: 'ask' });
  };

  const removeConversation = (id: string) => {
    deleteConversation(id);
    if (currentConversation === id) navigate({ name: 'ask' });
  };

  const settingsActive = route.name === 'settings';

  return (
    <AppContext.Provider value={context}>
      <div className="shell">
        <div className={`scrim${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <aside className={`sidebar${drawer ? ' open' : ''}`} aria-label="Navigation">
          <div className="row between">
            <a href="/" className="wordmark" onClick={onLinkClick}>
              <Wordmark />
            </a>
            <button type="button" className="icon-btn" onClick={() => setDrawer(false)} aria-label="Close menu" style={{ display: drawer ? undefined : 'none' }}>
              <IconClose />
            </button>
          </div>
          <nav className="nav">
            {NAV.map((item) => {
              const active = item.matches.includes(route.name);
              return (
                <a key={item.label} href={routePath(item.route)} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} onClick={onLinkClick}>
                  <item.icon /> {item.label}
                </a>
              );
            })}
          </nav>
          <div className="recent">
            <div className="recent-head">
              <span>Recent</span>
              {conversations.length > 0 && (
                <button type="button" onClick={clearAll}>
                  Clear
                </button>
              )}
            </div>
            {conversations.length === 0 ? (
              <div className="recent-empty">Questions you ask will be listed here.</div>
            ) : (
              <div className="recent-list">
                {conversations.slice(0, 40).map((conversation) => (
                  <div key={conversation.id} className={`recent-item${currentConversation === conversation.id ? ' active' : ''}`}>
                    <a href={`/?c=${conversation.id}`} onClick={onLinkClick} title={conversation.title}>
                      {conversation.title}
                    </a>
                    <button type="button" onClick={() => removeConversation(conversation.id)} aria-label="Delete conversation">
                      <IconTrash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="sidebar-foot">
            {profile ? (
              <a href="/settings" className="me" onClick={onLinkClick} title="Your details">
                <span className="avatar">{initials(profile.name)}</span>
                <span className="who">
                  <b>{profile.name}</b>
                  <span>
                    {profile.major}, {standingLabel(profile.year)}
                  </span>
                </span>
              </a>
            ) : (
              <button type="button" className="me" style={{ border: 0, background: 'none', textAlign: 'left' }} onClick={() => void requestProfile()}>
                <span className="avatar" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>
                  <IconUser style={{ width: 15, height: 15 }} />
                </span>
                <span className="who">
                  <b>Introduce yourself</b>
                  <span>To answer and post</span>
                </span>
              </button>
            )}
            <button type="button" className="icon-btn" onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon />
            </button>
            <a href="/settings" className={`icon-btn${settingsActive ? ' active' : ''}`} onClick={onLinkClick} title="Settings" aria-label="Settings" aria-current={settingsActive ? 'page' : undefined}>
              <IconSettings />
            </a>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button type="button" className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open menu">
              <IconMenu />
            </button>
            <a href="/" className="wordmark" onClick={onLinkClick}>
              <Wordmark />
            </a>
            <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon />
            </button>
          </header>
          <main>{page}</main>
          <nav className="tabbar" aria-label="Sections">
            {NAV.map((item) => {
              const active = item.matches.includes(route.name);
              return (
                <a key={item.label} href={routePath(item.route)} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} onClick={onLinkClick}>
                  <item.icon /> {item.short}
                </a>
              );
            })}
            <a href="/settings" className={settingsActive ? 'active' : undefined} aria-current={settingsActive ? 'page' : undefined} onClick={onLinkClick}>
              <IconSettings /> Settings
            </a>
          </nav>
        </div>
      </div>
      {toastMessage && (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      )}
      <ProfileModal open={profileAsk !== null} title={profileAsk?.title ?? ''} reason={profileAsk?.reason ?? ''} onClose={() => finishProfile(false)} onDone={() => finishProfile(true)} />
      <Welcome open={welcome && profileAsk === null && !moment} onDone={finishWelcome} />
      {moment && <Celebration title={moment.title} message={moment.message} action={moment.action} onClose={() => setMoment(null)} />}
    </AppContext.Provider>
  );
}
