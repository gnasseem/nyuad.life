import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getAccessCode, type HomePayload } from './api';
import { AccessGate } from './components/AccessGate';
import { AppContext } from './context';
import { IconAsk, IconAuto, IconBook, IconClock, IconMoon, IconSearch, IconSun } from './icons';
import { AskPage } from './pages/Ask';
import { BrowsePage } from './pages/Browse';
import { CoursesPage } from './pages/Courses';
import { HistoryPage } from './pages/History';
import { PostPage } from './pages/Post';
import { navigate, useRoute, type Route } from './router';
import { applyTheme, loadTheme, type Theme } from './store';

const NAV: Array<{ route: Route; label: string; icon: typeof IconAsk }> = [
  { route: { name: 'ask' }, label: 'Ask', icon: IconAsk },
  { route: { name: 'browse' }, label: 'Browse', icon: IconSearch },
  { route: { name: 'courses' }, label: 'Courses', icon: IconBook },
  { route: { name: 'history' }, label: 'History', icon: IconClock },
];

export function App() {
  const { route, search } = useRoute();
  const [home, setHome] = useState<HomePayload | null>(null);
  const [gate, setGate] = useState<'unknown' | 'open' | 'locked'>('unknown');
  const [health, setHealth] = useState<{ gemini: boolean; vectors: boolean } | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [toastMessage, setToastMessage] = useState('');
  const [askPrefill, setAskPrefillState] = useState<{ question: string; autoSend: boolean; token: number } | null>(null);

  const loadHome = useCallback(async () => {
    try {
      const payload = await api.home();
      setHome(payload);
      setGate('open');
    } catch (error) {
      if ((error as { status?: number }).status === 401) setGate('locked');
      else setGate('open');
    }
  }, []);

  useEffect(() => {
    api
      .health()
      .then((result) => setHealth({ gemini: result.gemini.configured, vectors: Boolean(result.archive?.vectors) }))
      .catch(() => setHealth({ gemini: false, vectors: false }));
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(''), 1800);
  }, []);

  const onNeedAccess = useCallback(() => setGate('locked'), []);
  const setAskPrefill = useCallback((prefill: { question: string; autoSend: boolean } | null) => {
    setAskPrefillState(prefill ? { ...prefill, token: Date.now() } : null);
  }, []);

  const context = useMemo(() => ({ home, toast, askPrefill, setAskPrefill }), [home, toast, askPrefill, setAskPrefill]);

  const cycleTheme = () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconAuto;

  const page = (() => {
    switch (route.name) {
      case 'browse':
        return <BrowsePage key={route.name} search={search} onNeedAccess={onNeedAccess} />;
      case 'post':
        return <PostPage id={route.id} onNeedAccess={onNeedAccess} />;
      case 'courses':
        return <CoursesPage code={route.code} onNeedAccess={onNeedAccess} />;
      case 'history':
        return <HistoryPage />;
      default:
        return <AskPage resumeId={search.get('c') ?? undefined} onNeedAccess={onNeedAccess} />;
    }
  })();

  return (
    <AppContext.Provider value={context}>
      <div className="shell">
        <nav className="nav" aria-label="Main">
          <a href="/" className="brand" onClick={(event) => { event.preventDefault(); navigate({ name: 'ask' }); }}>
            <span className="brand-mark">R</span>
            <span>
              <span className="brand-name">ROR Answers</span>
              <span className="brand-sub">NYUAD student archive</span>
            </span>
          </a>
          {NAV.map((item) => (
            <button key={item.label} type="button" className={`nav-link${route.name === item.route.name ? ' active' : ''}`} onClick={() => navigate(item.route)}>
              <item.icon /> {item.label}
            </button>
          ))}
          <div className="nav-spacer" />
          <div className="nav-foot">
            <button type="button" className="btn ghost sm" onClick={cycleTheme} style={{ justifyContent: 'flex-start' }}>
              <ThemeIcon /> {theme === 'system' ? 'Auto theme' : theme === 'light' ? 'Light theme' : 'Dark theme'}
            </button>
            {home && (
              <div className="nav-stats">
                {home.stats.posts.toLocaleString()} posts · {home.stats.comments.toLocaleString()} comments
                <br />
                {home.stats.oldestPost.slice(0, 4) === home.stats.newestPost.slice(0, 4) ? home.stats.newestPost.slice(0, 4) : `${home.stats.oldestPost.slice(0, 4)}–${home.stats.newestPost.slice(0, 4)}`} · updated {home.stats.builtAt.slice(0, 10)}
              </div>
            )}
          </div>
        </nav>

        <main className="main">
          {health && !health.gemini && (
            <div className="alert note" style={{ margin: '16px 24px 0', borderRadius: 12 }}>
              The server has no Gemini API key yet, so answers are disabled. Browsing and search still work.
            </div>
          )}
          {page}
        </main>

        <nav className="tabbar" aria-label="Main">
          {NAV.map((item) => (
            <button key={item.label} type="button" className={`tab${route.name === item.route.name ? ' active' : ''}`} onClick={() => navigate(item.route)}>
              <item.icon /> {item.label}
            </button>
          ))}
        </nav>
      </div>

      {gate === 'locked' && !getAccessCode() && <AccessGate onUnlocked={() => void loadHome()} />}
      {gate === 'locked' && getAccessCode() && <AccessGate onUnlocked={() => void loadHome()} />}
      {toastMessage && <div className="toast">{toastMessage}</div>}
    </AppContext.Provider>
  );
}
