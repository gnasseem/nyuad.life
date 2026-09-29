import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type HomePayload } from './api';
import { AppContext } from './context';
import { formatDate, formatRange, plural } from './format';
import { IconAuto, IconMoon, IconSun } from './icons';
import { AskPage } from './pages/Ask';
import { BrowsePage } from './pages/Browse';
import { CoursesPage } from './pages/Courses';
import { HistoryPage } from './pages/History';
import { PostPage } from './pages/Post';
import { onLinkClick, routePath, useRoute, type Route } from './router';
import { applyTheme, loadTheme, type Theme } from './store';

const NAV: Array<{ route: Route; label: string }> = [
  { route: { name: 'ask' }, label: 'Ask' },
  { route: { name: 'browse' }, label: 'Browse' },
  { route: { name: 'courses' }, label: 'Courses' },
  { route: { name: 'history' }, label: 'History' },
];

const THEME_LABEL: Record<Theme, string> = { system: 'Theme: follows your system', light: 'Theme: light', dark: 'Theme: dark' };

export function App() {
  const { route, search } = useRoute();
  const [home, setHome] = useState<HomePayload | null>(null);
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [toastMessage, setToastMessage] = useState('');
  const [askPrefill, setAskPrefillState] = useState<{ question: string; autoSend: boolean; token: number } | null>(null);

  useEffect(() => {
    api
      .home()
      .then(setHome)
      .catch(() => setHome(null));
    api
      .health()
      .then((result) => setGeminiReady(result.gemini.configured))
      .catch(() => setGeminiReady(false));
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(''), 1800);
  }, []);

  const setAskPrefill = useCallback((prefill: { question: string; autoSend: boolean } | null) => {
    setAskPrefillState(prefill ? { ...prefill, token: Date.now() } : null);
  }, []);

  const context = useMemo(() => ({ home, toast, askPrefill, setAskPrefill }), [home, toast, askPrefill, setAskPrefill]);

  const cycleTheme = () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconAuto;
  const activeNav = route.name === 'post' ? 'browse' : route.name;

  const page = (() => {
    switch (route.name) {
      case 'browse':
        return <BrowsePage key={route.name} search={search} />;
      case 'post':
        return <PostPage id={route.id} />;
      case 'courses':
        return <CoursesPage code={route.code} />;
      case 'history':
        return <HistoryPage />;
      default:
        return <AskPage resumeId={search.get('c') ?? undefined} />;
    }
  })();

  const stats = home?.stats;

  return (
    <AppContext.Provider value={context}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-inner">
            <a href="/" className="brand" onClick={onLinkClick}>
              <span className="brand-mark" aria-hidden="true">
                R
              </span>
              <span>ROR Answers</span>
              <span className="brand-sub">NYU Abu Dhabi</span>
            </a>
            <nav className="topnav" aria-label="Main">
              {NAV.map((item) => (
                <a key={item.label} href={routePath(item.route)} className={activeNav === item.route.name ? 'active' : undefined} aria-current={activeNav === item.route.name ? 'page' : undefined} onClick={onLinkClick}>
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="topbar-actions">
              <button type="button" className="icon-btn" onClick={cycleTheme} title={`${THEME_LABEL[theme]}. Click to change.`} aria-label={THEME_LABEL[theme]}>
                <ThemeIcon />
              </button>
            </div>
          </div>
        </header>

        <main className="main">
          {geminiReady === false && (
            <div className="notice">
              <div className="alert note">The server has no Gemini API key yet, so answers are disabled. Browsing and search still work.</div>
            </div>
          )}
          {page}
        </main>

        <footer className="footer">
          <div className="footer-inner">
            <span>
              {stats
                ? `${plural(stats.posts, 'post')} and ${plural(stats.comments, 'comment')} from the Room of Requirement, ${formatRange(stats.oldestPost, stats.newestPost)}. Archive updated ${formatDate(stats.builtAt.slice(0, 10))}.`
                : 'An archive of the NYU Abu Dhabi Room of Requirement group.'}
            </span>
            <span>Unofficial and student-run. Answers are generated from posts and can be wrong; check the cited threads.</span>
          </div>
        </footer>
      </div>
      {toastMessage && (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      )}
    </AppContext.Provider>
  );
}
