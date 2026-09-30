import { useEffect, useState } from 'react';
import { api } from '../api';
import { APP_NAME, APP_TAGLINE, APP_VERSION, GROUP_URL } from '../brand';
import { Mark } from '../components/Logo';
import { useApp } from '../context';
import { initials, plural, standingLabel } from '../format';
import { IconCheck, IconExternal, IconLogout, IconTrash, IconUser } from '../icons';
import { onLinkClick } from '../router';
import { clearConversations, forgetDevice, loadConversations, onConversationsChange, type Theme } from '../store';

const THEMES: Array<{ id: Theme; label: string; hint: string }> = [
  { id: 'system', label: 'System', hint: 'Follows your device' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' },
];

export function SettingsPage() {
  const { profile, setProfile, requestProfile, theme, setTheme, toast, health, boardProblem } = useApp();
  const [count, setCount] = useState(() => loadConversations().length);
  const [stats, setStats] = useState<{ open: number; answered: number; answers: number; helpers: number } | null>(null);

  useEffect(() => onConversationsChange(() => setCount(loadConversations().length)), []);
  useEffect(() => {
    if (boardProblem) return;
    api.board
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [boardProblem]);

  const clear = () => {
    if (!window.confirm('Delete every saved conversation on this device?')) return;
    clearConversations();
    toast('Conversations cleared');
  };

  const forget = () => {
    if (!window.confirm('Forget everything this site keeps on this device: your profile, conversations and the key that ties your questions to this browser?')) return;
    forgetDevice();
    setProfile(null);
    window.location.href = '/';
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>How the site looks, who it thinks you are, and what it keeps on this device.</p>
        </div>
      </div>

      <section className="settings-section">
        <h2>Appearance</h2>
        <p>Light and dark follow your system unless you pick one.</p>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {THEMES.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={theme === entry.id} className={`theme-option${theme === entry.id ? ' on' : ''}`} onClick={() => setTheme(entry.id)}>
              <span className={`theme-swatch ${entry.id}`} />
              <span>{entry.label}</span>
              <span className="faint small" style={{ fontWeight: 500, marginTop: -6 }}>
                {entry.hint}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>You</h2>
        <p>Your major and year route questions to you; your name goes next to what you write.</p>
        <div className="settings-list">
          {profile ? (
            <div className="settings-row">
              <div className="row" style={{ gap: 12, minWidth: 0 }}>
                <span className="avatar">{initials(profile.name)}</span>
                <div className="text">
                  <b>{profile.name}</b>
                  <span>
                    {profile.netId} · {profile.major} · {standingLabel(profile.year)} · {plural(profile.answers, 'answer')}
                  </span>
                </div>
              </div>
              <div className="actions">
                <button type="button" className="btn sm" onClick={() => void requestProfile({ title: 'Update your details', reason: 'Changed major, moved a year up, or just typed something wrong? Fix it here.' })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    setProfile(null);
                    toast('Signed out on this device');
                  }}
                >
                  <IconLogout /> Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <div className="row" style={{ gap: 12 }}>
                <span className="avatar" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>
                  <IconUser style={{ width: 16, height: 16 }} />
                </span>
                <div className="text">
                  <b>Nobody yet</b>
                  <span>Introduce yourself to answer questions and post announcements.</span>
                </div>
              </div>
              <button type="button" className="btn sm primary" onClick={() => void requestProfile()}>
                Introduce yourself
              </button>
            </div>
          )}
        </div>
      </section>

      {profile && (
        <section className="settings-section">
          <h2>Weekly roundup</h2>
          <p>Every Monday, the open questions a {profile.major} {standingLabel(profile.year)} could answer, by email.</p>
          <div className="settings-list">
            <div className="settings-row">
              <div className="text">
                <b>Email me open questions</b>
                <span>Sent to {profile.netId}@nyu.edu, at most once a week, only when there is something for you.</span>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={profile.digest !== false}
                aria-label="Weekly roundup"
                onClick={() => {
                  const on = profile.digest === false;
                  setProfile({ ...profile, digest: on });
                  api.board
                    .digest({ netId: profile.netId, on })
                    .then(() => toast(on ? 'Roundup on' : 'Roundup off'))
                    .catch((err) => toast(err instanceof Error ? err.message : 'Could not save that.'));
                }}
              />
            </div>
          </div>
        </section>
      )}

      <section className="settings-section">
        <h2>On this device</h2>
        <p>Conversations are kept in this browser only. Nothing you ask is stored on the server.</p>
        <div className="settings-list">
          <div className="settings-row">
            <div className="text">
              <b>Saved conversations</b>
              <span>{count === 0 ? 'Nothing saved yet.' : `${plural(count, 'conversation')} in the Recent list.`}</span>
            </div>
            <button type="button" className="btn sm ghost" onClick={clear} disabled={count === 0}>
              <IconTrash /> Clear
            </button>
          </div>
          <div className="settings-row">
            <div className="text">
              <b>Forget this device</b>
              <span>Removes your profile, conversations, theme and the anonymous key behind your questions.</span>
            </div>
            <button type="button" className="btn sm danger" onClick={forget}>
              Forget
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>About</h2>
        <div className="settings-list">
          <div className="settings-row" style={{ alignItems: 'flex-start' }}>
            <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
              <Mark className="about-mark" />
              <div className="text">
                <b>
                  {APP_NAME} <span className="faint" style={{ fontWeight: 500 }}>v{APP_VERSION}</span>
                </b>
                <span>{APP_TAGLINE}</span>
                <span style={{ marginTop: 6 }}>
                  Answers are written from official NYUAD pages and Room of Requirement threads by a model that cites what it used and says how sure it is. Official pages win on rules; threads win on experience. Falcon trades go to the Falcons page; listings and rides are sent to the group.
                </span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="text">
              <b>Server</b>
              <span>
                {health ? (
                  <>
                    {health.gemini.configured ? 'Answers on' : 'Answers off'} · {health.embeddings?.semanticSearch ? 'semantic search on' : 'keyword search only'} ·{' '}
                    {health.official?.pages ? `${health.official.pages.toLocaleString()} official pages` : 'no official pages yet'} ·{' '}
                    {boardProblem ? 'board off' : `board on${stats ? `, ${plural(stats.answers, 'answer')} from ${plural(stats.helpers, 'student')}` : ''}`}
                  </>
                ) : (
                  'Checking'
                )}
              </span>
            </div>
            {health && !boardProblem && (
              <span className="pill k-ok">
                <IconCheck /> Healthy
              </span>
            )}
          </div>
          {boardProblem && <div className="alert warn">{boardProblem}</div>}
          <div className="row wrap" style={{ marginTop: 4 }}>
            <a className="btn sm" href={GROUP_URL} target="_blank" rel="noreferrer">
              <IconExternal /> The group on Facebook
            </a>
            <a className="btn sm" href="/falcons" onClick={onLinkClick}>
              Falcons exchange
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
