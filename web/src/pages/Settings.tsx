import { useEffect, useState } from 'react';
import { APP_NAME, APP_TAGLINE, APP_VERSION, GROUP_URL } from '../brand';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { plural, standingLabel } from '../format';
import { IconExternal } from '../icons';
import { clearConversations, forgetDevice, loadConversations, onConversationsChange, type Theme } from '../store';

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

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
        health.gemini.configured ? 'Answers on' : 'Answers off',
        health.embeddings?.semanticSearch ? 'semantic search on' : 'keyword search only',
        health.official?.pages ? `${health.official.pages.toLocaleString()} official pages` : 'no official pages',
        boardProblem ? 'board off' : 'board on',
      ].join(', ')
    : 'Checking';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      <section className="settings-section">
        <h2>Theme</h2>
        <Segmented value={theme} onChange={setTheme} label="Theme" options={THEMES} />
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
              <span>{count === 0 ? 'None saved.' : `${plural(count, 'conversation')} saved in this browser only.`}</span>
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
            <button type="button" className="btn sm" onClick={forget}>
              Delete
            </button>
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
              <span>{APP_TAGLINE}</span>
            </div>
            <a className="btn sm" href={GROUP_URL} target="_blank" rel="noreferrer">
              <IconExternal /> Facebook group
            </a>
          </div>
          <div className="settings-row">
            <div className="text">
              <b>Server</b>
              <span>{server}</span>
            </div>
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
