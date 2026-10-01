import { useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION, GROUP_URL } from '../brand';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, standingLabel } from '../format';
import { IconExternal } from '../icons';
import { clearConversations, forgetDevice, loadConversations, onConversationsChange, type Theme } from '../store';

const THEMES: Array<{ id: Theme; label: string; mark: string }> = [
  { id: 'system', label: 'Automatic', mark: 'A' },
  { id: 'light', label: 'Day service', mark: 'D' },
  { id: 'dark', label: 'Night service', mark: 'N' },
];

/** A tiny line map in each theme's own colours, so the choice is seen rather than described. */
function ThemeArt({ theme }: { theme: Theme }) {
  const day = { ground: '#eef1f6', plate: '#ffffff', ink: '#0b1230' };
  const night = { ground: '#0a1130', plate: '#0f1839', ink: '#f0f2fa' };
  const art = (c: typeof day, clip?: string) => (
    <g clipPath={clip}>
      <rect width="200" height="80" fill={c.ground} />
      <path d="M -10 22 H 70 L 100 52 H 210" fill="none" stroke="#e0281e" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M -10 62 H 60 L 90 32 H 210" fill="none" stroke="#1e5bff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 140 -10 V 90" fill="none" stroke="#f5b400" strokeWidth="6" strokeLinecap="round" />
      <circle cx="95" cy="42" r="9" fill={c.plate} stroke={c.ink} strokeWidth="4" />
      <circle cx="140" cy="52" r="5.5" fill={c.plate} stroke="#f5b400" strokeWidth="3.5" />
    </g>
  );
  return (
    <svg viewBox="0 0 200 80" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <clipPath id="half">
          <path d="M 120 0 H 200 V 80 H 80 Z" />
        </clipPath>
      </defs>
      {art(theme === 'dark' ? night : day)}
      {theme === 'system' && art(night, 'url(#half)')}
    </svg>
  );
}

export function SettingsPage() {
  const { profile, setProfile, requestProfile, theme, setTheme, toast, health, boardProblem } = useApp();
  const [count, setCount] = useState(() => loadConversations().length);

  useEffect(() => onConversationsChange(() => setCount(loadConversations().length)), []);

  const clear = () => {
    if (!window.confirm('Delete all saved conversations?')) return;
    clearConversations();
    toast('Conversations deleted');
  };

  const forget = () => {
    if (!window.confirm('Delete everything this site keeps in this browser?')) return;
    forgetDevice();
    setProfile(null);
    window.location.href = '/';
  };

  const server = health
    ? [
        health.gemini.configured ? 'Answers on' : 'Answers paused',
        health.archive ? plural(health.archive.posts, 'thread') : '',
        health.official?.pages ? `${health.official.pages.toLocaleString()} official pages` : '',
        boardProblem ? 'board not running' : '',
      ]
        .filter(Boolean)
        .join(', ')
    : 'Checking';

  return (
    <div className="page narrow">
      <Sign title="Settings" ar="الإعدادات" />

      <section className="settings-section">
        <h2>Theme</h2>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {THEMES.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={theme === entry.id} className="theme-card" onClick={() => setTheme(entry.id)}>
              <span className="theme-art">
                <ThemeArt theme={entry.id} />
              </span>
              <b>
                <i>{entry.mark}</i> {entry.label}
              </b>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>Your details</h2>
        <div className="list">
          {profile ? (
            <div className="settings-row">
              <div className="text">
                <b>{profile.name}</b>
                <span>
                  {profile.netId}, {profile.major}, {standingLabel(profile.year)}, {plural(profile.answers, 'answer')}
                </span>
              </div>
              <div className="actions">
                <button type="button" className="btn sm" onClick={() => void requestProfile({ title: 'Edit details', reason: '' })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    setProfile(null);
                    toast('Details removed');
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <div className="text">
                <b>No details saved</b>
                <span>Needed to answer questions or post.</span>
              </div>
              <button type="button" className="btn sm primary" onClick={() => void requestProfile()}>
                Add details
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2>This browser</h2>
        <div className="list">
          <div className="settings-row">
            <div className="text">
              <b>Conversations</b>
              <span>{count === 0 ? 'None saved.' : `${plural(count, 'conversation')}, saved in this browser only.`}</span>
            </div>
            <button type="button" className="btn sm" onClick={clear} disabled={count === 0}>
              Delete
            </button>
          </div>
          <div className="settings-row">
            <div className="text">
              <b>Everything</b>
              <span>Your details, conversations, theme and the key behind your posts.</span>
            </div>
            <button type="button" className="btn sm danger" onClick={forget}>
              Delete
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Shortcuts</h2>
        <div className="list">
          <div className="settings-row">
            <div className="text">
              <b>Go anywhere</b>
              <span>Ask, or jump to a section, a course or a past question.</span>
            </div>
            <span className="row-flex">
              <kbd>⌘</kbd>
              <kbd>K</kbd>
              <span className="faint small">or</span>
              <kbd>/</kbd>
            </span>
          </div>
          <div className="settings-row">
            <div className="text">
              <b>Jump to a line</b>
              <span>G, then A for Ask, Q for Questions, N for Notices, M for Market, G for Guide.</span>
            </div>
            <span className="row-flex">
              <kbd>G</kbd>
              <kbd>A</kbd>
            </span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>About</h2>
        <div className="list">
          <div className="settings-row">
            <div className="text">
              <b>
                {APP_NAME} {APP_VERSION}
              </b>
              <span>{server}</span>
            </div>
            <a className="btn sm" href={GROUP_URL} target="_blank" rel="noreferrer">
              <IconExternal /> Facebook group
            </a>
          </div>
          {boardProblem && (
            <div className="settings-row">
              <div className="text">
                <span>{boardProblem}</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
