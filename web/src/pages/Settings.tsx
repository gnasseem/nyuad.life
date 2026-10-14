import { useEffect, useState } from 'react';
import { api } from '../api';
import { GROUP_URL } from '../brand';
import { ChatGPTSignIn } from '../components/ChatGPT';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, standingLabel } from '../format';
import { IconExternal, IconShield } from '../icons';
import { onLinkClick } from '../router';
import { clearConversations, forgetDevice, loadConversations, onConversationsChange } from '../store';

export function SettingsPage() {
  const { profile, setProfile, requestProfile, toast, boardProblem, chatgpt, refreshChatGPT } = useApp();
  const [count, setCount] = useState(() => loadConversations().length);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => onConversationsChange(() => setCount(loadConversations().length)), []);

  const clear = () => {
    if (!window.confirm('Delete all saved conversations?')) return;
    clearConversations();
    toast('Conversations deleted');
  };

  const forget = async () => {
    if (!window.confirm('Clear conversations, your plan, profile details and preferences from this browser? You can log in again with your NYU email.')) return;
    await api.auth.logout();
    forgetDevice();
    setProfile(null);
    window.location.href = '/';
  };

  const deleteAccount = async () => {
    if (!profile || deleting || !window.confirm(`Delete your ${profile.netId} account and the posts made from this browser? This cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.board.deleteProfile(profile.netId);
      await api.auth.logout();
      await api.chatgpt.logout().catch(() => {});
      forgetDevice(true);
      setProfile(null);
      window.location.href = '/';
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the account.');
      setDeleting(false);
    }
  };

  return (
    <div className="page settings">
      <Sign title="Settings" ar="الإعدادات" />

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
        <h2>Account</h2>
        <div className="settings-row"><div className="text"><b>{profile ? `${profile.netId}@nyu.edu` : 'Not logged in'}</b><span>Use this email to log in on your phone or laptop.</span></div>
          <button type="button" className="btn" onClick={async () => { await api.auth.logout(); setProfile(null); window.location.href = '/'; }}>Log out</button>
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
                    if (!window.confirm('Sign out on this browser? You will need to add your details again to use the site.')) return;
                    setProfile(null);
                  }}
                >
                  Sign out
                </button>
                <button type="button" className="btn sm danger" onClick={() => void deleteAccount()} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Delete account'}
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <div className="text">
                <b>No details saved</b>
                <span>Name, NetID, major and year. Everyone adds them once to use the site</span>
              </div>
              <button type="button" className="btn sm primary" onClick={() => void requestProfile()}>
                Add details
              </button>
            </div>
          )}
          {deleteError && <div className="alert error">{deleteError}</div>}
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
              <b>Local data</b>
              <span>Clear conversations, your plan, details and preferences. Your sign-in key stays so your NetID still works here.</span>
            </div>
            <button type="button" className="btn sm danger" onClick={forget}>
              Clear
            </button>
          </div>
        </div>
      </section>

      <AdminSection />

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

/** For administrators, the way to the admin page. */
function AdminSection() {
  const { admin } = useApp();
  if (!admin) return null;
  return (
    <section className="settings-section" id="admin">
      <h2>Admin</h2>
      <div className="list">
        <div className="settings-row">
          <div className="text">
            <b className="admin-on">
              <IconShield /> Admin mode is on
            </b>
            <span>Usage, sign-ups, the answer models and moderation are on the admin page. Every post shows a remove button.</span>
          </div>
          <a className="btn sm primary" href="/admin" onClick={onLinkClick}>
            Open admin
          </a>
        </div>
      </div>
    </section>
  );
}
