import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, boardProblem as describeBoardProblem, type Health, type HomePayload, type Profile } from './api';
import { Wordmark } from './components/Logo';
import { ProfileModal } from './components/ProfileForm';
import { AppContext, type Prefill, type ProfileRequest } from './context';
import { initials, standingLabel } from './format';
import { IconAsk, IconAuto, IconBook, IconClose, IconCoins, IconMegaphone, IconMenu, IconMoon, IconQuestions, IconSettings, IconSun, IconTrash, IconUser } from './icons';
import { AnnouncementsPage } from './pages/Announcements';
import { AskPage } from './pages/Ask';
import { FalconsPage } from './pages/Falcons';
import { GuidePage } from './pages/Guide';
import { PostPage } from './pages/Post';
import { QuestionPage, QuestionsPage } from './pages/Questions';
import { SettingsPage } from './pages/Settings';
import { navigate, onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, clearConversations, deleteConversation, loadConversations, loadProfile, loadTheme, onConversationsChange, saveProfile, type Conversation, type Theme } from './store';
import { standingFor } from './year';

const NAV: Array<{ route: Route; label: string; icon: typeof IconAsk; matches: Route['name'][] }> = [
  { route: { name: 'ask' }, label: 'Ask', icon: IconAsk, matches: ['ask'] },
  { route: { name: 'questions' }, label: 'Questions', icon: IconQuestions, matches: ['questions', 'question'] },
  { route: { name: 'announcements' }, label: 'Notices', icon: IconMegaphone, matches: ['announcements'] },
  { route: { name: 'falcons' }, label: 'Falcons', icon: IconCoins, matches: ['falcons'] },
  { route: { name: 'guide' }, label: 'Guide', icon: IconBook, matches: ['guide', 'post'] },
];

const THEME_LABEL: Record<Theme, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
const DEFAULT_PROFILE_REQUEST = { title: 'Your details', reason: 'Your major and year decide which questions reach you. Your name appears next to what you write.' };

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
  const [profileAsk, setProfileAsk] = useState<{ title: string; reason: string } | null>(null);
  const profileRequest = useRef<((saved: boolean) => void) | null>(null);
  const conversations = useConversations();

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
      .home()
      .then(setHome)
      .catch(() => setHome(null));
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, gemini: { configured: false }, board: { configured: false } }));
  }, []);

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

  const boardProblem = useMemo(() => describeBoardProblem(health), [health]);

  const context = useMemo(
    () => ({ home, health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill, setBoardPrefill }),
    [home, health, boardProblem, profile, setProfile, requestProfile, theme, setTheme, toast, askPrefill, setAskPrefill, boardPrefill],
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
      case 'falcons':
        return <FalconsPage />;
      case 'guide':
        return <GuidePage section={route.section} id={route.id} />;
      case 'post':
        return <PostPage id={route.id} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <AskPage resumeId={currentConversation ?? undefined} />;
    }
  })();

  const clearAll = () => {
    if (!window.confirm('Delete all saved conversations?')) return;
    clearConversations();
    if (currentConversation) navigate({ name: 'ask' });
  };

  const removeConversation = (id: string) => {
    deleteConversation(id);
    if (currentConversation === id) navigate({ name: 'ask' });
  };

  const settingsActive = route.name === 'settings';
  const navLinks = NAV.map((item) => {
    const active = item.matches.includes(route.name);
    return (
      <a key={item.label} href={routePath(item.route)} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} onClick={onLinkClick}>
        <item.icon /> {item.label}
      </a>
    );
  });

  return (
    <AppContext.Provider value={context}>
      <div className="shell">
        <div className={`scrim${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <aside className={`sidebar${drawer ? ' open' : ''}`} aria-label="Navigation">
          <div className="sidebar-top">
            <a href="/" className="wordmark" onClick={onLinkClick}>
              <Wordmark />
            </a>
            <button type="button" className="icon-btn" onClick={() => setDrawer(false)} aria-label="Close menu" style={{ display: drawer ? undefined : 'none' }}>
              <IconClose />
            </button>
          </div>
          <nav className="nav">{navLinks}</nav>
          <div className="recent">
            <div className="recent-head">
              <span className="eyebrow">Recent</span>
              {conversations.length > 0 && (
                <button type="button" onClick={clearAll}>
                  Clear
                </button>
              )}
            </div>
            {conversations.length === 0 ? (
              <div className="recent-empty">No conversations yet.</div>
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
              <a href="/settings" className="me" onClick={onLinkClick}>
                <span className="avatar">{initials(profile.name)}</span>
                <span className="who">
                  <b>{profile.name}</b>
                  <span>
                    {profile.major}, {standingLabel(profile.year)}
                  </span>
                </span>
              </a>
            ) : (
              <button type="button" className="me" onClick={() => void requestProfile()}>
                <span className="avatar plain">
                  <IconUser style={{ width: 14, height: 14 }} />
                </span>
                <span className="who">
                  <b>Add details</b>
                  <span>To answer or post</span>
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
            <a href="/settings" className={`icon-btn${settingsActive ? ' active' : ''}`} onClick={onLinkClick} aria-label="Settings">
              <IconSettings />
            </a>
          </header>
          <main>{page}</main>
          <nav className="tabbar" aria-label="Sections">
            {navLinks}
          </nav>
        </div>
      </div>
      {toastMessage && (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      )}
      <ProfileModal open={profileAsk !== null} title={profileAsk?.title ?? ''} reason={profileAsk?.reason ?? ''} onClose={() => finishProfile(false)} onDone={() => finishProfile(true)} />
    </AppContext.Provider>
  );
}
