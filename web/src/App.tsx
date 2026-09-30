import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Health, type HomePayload, type Profile } from './api';
import { APP_NAME } from './brand';
import { Celebration } from './components/Celebration';
import { AppContext, type Prefill } from './context';
import { initials, standingLabel } from './format';
import { Door, IconArchive, IconAsk, IconAuto, IconClose, IconMegaphone, IconMenu, IconMoon, IconQuestions, IconSun, IconTrash } from './icons';
import { AnnouncementsPage } from './pages/Announcements';
import { AskPage } from './pages/Ask';
import { BrowsePage } from './pages/Browse';
import { CoursesPage } from './pages/Courses';
import { PostPage } from './pages/Post';
import { QuestionPage, QuestionsPage } from './pages/Questions';
import { navigate, onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, clearConversations, deleteConversation, loadConversations, loadProfile, loadTheme, onConversationsChange, saveProfile, type Conversation, type Theme } from './store';
import { promotionMessage, standingFor } from './year';

const NAV: Array<{ route: Route; label: string; icon: typeof IconAsk; matches: Route['name'][] }> = [
  { route: { name: 'ask' }, label: 'Ask', icon: IconAsk, matches: ['ask'] },
  { route: { name: 'questions' }, label: 'Questions', icon: IconQuestions, matches: ['questions', 'question'] },
  { route: { name: 'announcements' }, label: 'Announcements', icon: IconMegaphone, matches: ['announcements'] },
  { route: { name: 'browse' }, label: 'Archive', icon: IconArchive, matches: ['browse', 'post', 'courses'] },
];

const THEME_LABEL: Record<Theme, string> = { system: 'Theme follows your system', light: 'Light theme', dark: 'Dark theme' };

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
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [toastMessage, setToastMessage] = useState('');
  const [askPrefill, setAskPrefillState] = useState<(Prefill & { token: number }) | null>(null);
  const [boardPrefill, setBoardPrefill] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [moment, setMoment] = useState<{ title: string; message: string; action?: string } | null>(null);
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

  const celebrate = useCallback((next: { title: string; message: string; action?: string }) => setMoment(next), []);

  const context = useMemo(
    () => ({ home, health, profile, setProfile, toast, askPrefill, setAskPrefill, boardPrefill, setBoardPrefill, celebrate }),
    [home, health, profile, setProfile, toast, askPrefill, setAskPrefill, boardPrefill, celebrate],
  );

  const cycleTheme = () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
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

  return (
    <AppContext.Provider value={context}>
      <div className="shell">
        <div className={`scrim${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <aside className={`sidebar${drawer ? ' open' : ''}`} aria-label="Navigation">
          <div className="row between">
            <a href="/" className="wordmark" onClick={onLinkClick}>
              <Door /> {APP_NAME}
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
              <a href="/questions?tab=help" className="me" onClick={onLinkClick} title="Answer questions">
                <span className="avatar">{initials(profile.name)}</span>
                <span style={{ minWidth: 0 }}>
                  <b>{profile.name}</b>
                  <span>
                    {profile.major}, {standingLabel(profile.year)}
                  </span>
                </span>
              </a>
            ) : (
              <span />
            )}
            <button type="button" className="icon-btn" onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon />
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button type="button" className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open menu">
              <IconMenu />
            </button>
            <a href="/" className="wordmark" onClick={onLinkClick}>
              <Door /> {APP_NAME}
            </a>
            <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={THEME_LABEL[theme]}>
              <ThemeIcon />
            </button>
          </header>
          <main>{page}</main>
        </div>
      </div>
      {toastMessage && (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      )}
      {moment && <Celebration title={moment.title} message={moment.message} action={moment.action} onClose={() => setMoment(null)} />}
    </AppContext.Provider>
  );
}
