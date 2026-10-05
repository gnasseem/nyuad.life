import { useEffect, useState } from 'react';
import { api } from '../api';
import { GROUP_URL } from '../brand';
import { ChatGPTSignIn } from '../components/ChatGPT';
import { PageHeader } from '../components/PageHeader';
import { useApp } from '../context';
import { plural, standingLabel } from '../format';
import { IconExternal } from '../icons';
import { clearConversations, forgetDevice, loadConversations, onConversationsChange, type Theme } from '../store';

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** A tiny page in each theme's own colours, so the choice is seen rather than described. */
function ThemeArt({ theme }: { theme: Theme }) {
  const day = { ground: '#f4f4f5', plate: '#ffffff', line: '#e4e4e7', ink: '#a1a1aa', accent: '#57068c' };
  const night = { ground: '#18181b', plate: '#09090b', line: '#2a2a2e', ink: '#52525b', accent: '#8a3fc7' };
  const art = (c: typeof day, clip?: string) => (
    <g clipPath={clip}>
      <rect width="200" height="80" fill={c.ground} />
      <rect x="24" y="14" width="152" height="80" rx="6" fill={c.plate} stroke={c.line} />
      <rect x="40" y="30" width="64" height="7" rx="3.5" fill={c.ink} />
      <rect x="40" y="46" width="112" height="5" rx="2.5" fill={c.line} />
      <rect x="40" y="58" width="92" height="5" rx="2.5" fill={c.line} />
      <rect x="132" y="28" width="28" height="11" rx="3" fill={c.accent} />
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
  const { profile, setProfile, requestProfile, theme, setTheme, toast, boardProblem, chatgpt, refreshChatGPT } = useApp();
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

  return (
    <div className="page settings">
      <PageHeader title="Settings" description="Theme, your details and what this browser keeps." />

      <section className="settings-section">
        <h2>Theme</h2>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {THEMES.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={theme === entry.id} className="theme-card" onClick={() => setTheme(entry.id)}>
              <span className="theme-art">
                <ThemeArt theme={entry.id} />
              </span>
              <b>{entry.label}</b>
            </button>
          ))}
        </div>
      </section>

      {chatgpt?.available && (
        <section className="settings-section">
          <h2>ChatGPT</h2>
          <div className="list">
            <div className="settings-row">
              <div className="text">
                <b>{chatgpt.connected ? `Connected${chatgpt.plan ? ` (${chatgpt.plan[0]!.toUpperCase()}${chatgpt.plan.slice(1)} plan)` : ''}` : 'Not connected'}</b>
                <span>{chatgpt.connected ? `Answers run on the ChatGPT plan of ${chatgpt.email || chatgpt.name || 'your account'}, within the limit you set for this site in ChatGPT.` : chatgpt.required ? 'Answers here run on your own ChatGPT plan: connect it to ask.' : 'Connect your ChatGPT plan and your answers run on it instead of the site’s shared quota.'}</span>
              </div>
              <div className="actions">
                {chatgpt.connected ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      await api.chatgpt.logout().catch(() => {});
                      refreshChatGPT();
                      toast('ChatGPT disconnected');
                    }}
                  >
                    Disconnect
                  </button>
                ) : (
                  <ChatGPTSignIn className="btn sm primary" />
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="settings-section">
        <h2>Your details</h2>
        <div className="list">
          {profile ? (
            <div className="settings-row">
              <div className="text">
                <b>{profile.name}</b>
                <span>
                  {profile.major}, {standingLabel(profile.year)}
                </span>
              </div>
              <div className="actions">
                <button type="button" className="btn sm" onClick={() => void requestProfile({ title: 'Edit details' })}>
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
                <span>Name, NetID, major and year. Asked once, the first time you answer questions or post something</span>
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
          {count > 0 && (
            <div className="settings-row">
              <div className="text">
                <b>Conversations</b>
                <span>{plural(count, 'conversation')}</span>
              </div>
              <button type="button" className="btn sm" onClick={clear}>
                Delete
              </button>
            </div>
          )}
          <div className="settings-row">
            <div className="text">
              <b>All data on this browser</b>
              <span>Conversations, your details and the key that lets you edit or remove what you posted</span>
            </div>
            <button type="button" className="btn sm danger" onClick={forget}>
              Delete all
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>About</h2>
        <div className="list">
          <div className="settings-row">
            <div className="text">
              <b>Room of Requirement</b>
              <span>The Facebook group behind the archive</span>
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
