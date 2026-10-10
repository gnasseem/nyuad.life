import { useEffect, useState, type FormEvent } from 'react';
import { api, type Profile } from '../api';
import { useApp } from '../context';
import { saveAccountKey } from '../store';
import { Modal } from './Modal';
import { classYears } from '../year';

// Mirrors MAJORS in lib/board.ts; the web bundle cannot import server code.
const MAJORS = [
  'Arab Crossroads Studies', 'Art and Art History', 'Bioengineering', 'Biology', 'Business, Organizations and Society', 'Chemistry', 'Civil Engineering',
  'Computer Engineering', 'Computer Science', 'Economics', 'Electrical Engineering', 'Film and New Media', 'General Engineering', 'History',
  'Interactive Media', 'Legal Studies', 'Literature and Creative Writing', 'Mathematics', 'Mechanical Engineering', 'Music', 'Philosophy', 'Physics',
  'Political Science', 'Psychology', 'Social Research and Public Policy', 'Theater', 'Undecided', 'Other',
];

/** Name, NetID, major and year. Used as the sign-up step every new visitor goes through, and to edit them later. */
/** The three steps of signing up, shown above the form when `steps` is set. */
function Steps({ at }: { at: 0 | 1 | 2 }) {
  return (
    <ol className="auth-steps" aria-label={`Step ${at + 1} of 3`}>
      {['Email', 'Code', 'Your details'].map((label, i) => (
        <li key={label} className={i < at ? 'done' : i === at ? 'now' : undefined} aria-current={i === at ? 'step' : undefined}>
          <span>{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function ProfileForm({ onDone, submitLabel = 'Save', steps = false }: { onDone(profile: Profile): void; submitLabel?: string; steps?: boolean }) {
  const { profile, setProfile } = useApp();
  const years = classYears();
  const [name, setName] = useState(profile?.name ?? '');
  const [netId, setNetId] = useState(profile?.netId ?? '');
  const [major, setMajor] = useState(profile?.major ?? '');
  const [classOf, setClassOf] = useState<number>(profile?.classOf ?? years[1]!.value);
  const [verified, setVerified] = useState(false);
  const [email, setEmail] = useState(profile ? `${profile.netId}@nyu.edu` : '');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void api.auth.me().then((result) => {
      if (result.netId) { setVerified(true); setNetId(result.netId); }
    }).catch(() => {});
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    const draft = { netId: netId.trim().toLowerCase(), name: name.trim(), major, classOf };
    try {
      const result = await api.board.profile(draft);
      setProfile(result.profile);
      onDone(result.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the details.');
    } finally {
      setSaving(false);
    }
  };

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      if (!sent) {
        const result = await api.auth.send(email);
        setEmail(result.email); setSent(true); setRetryAt(Date.now() + 60_000);
      } else {
        const result = await api.auth.verify(email, code);
        saveAccountKey(result.key); setNetId(result.netId); setVerified(true);
        if (result.profile) { setProfile(result.profile); onDone(result.profile); }
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not log in.'); }
    finally { setSaving(false); }
  };
  if (!verified) return (
    <form className="stack auth-form" onSubmit={(event) => void login(event)}>
      {steps && <Steps at={sent ? 1 : 0} />}
      <p className="muted">Log in or create an account with your NYU email. Your account works on every device.</p>
      <div className="field">
        <label htmlFor="pf-email">NYU email</label>
        <input id="pf-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="abc1234@nyu.edu" autoComplete="email" autoCapitalize="off" required disabled={sent} data-autofocus />
      </div>
      {sent && <div className="field">
        <label htmlFor="pf-code">Verification code</label>
        <input id="pf-code" className="input otp-input" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
        <p className="small muted">Sent to {email}. Check your inbox and spam folder; the code expires in 10 minutes.</p>
      </div>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Please wait…' : sent ? 'Verify and log in' : 'Send verification code'}</button>
      {sent && <div className="actions">
        <button type="button" className="btn ghost" disabled={saving || now < retryAt} onClick={async () => {
          setSaving(true); setError('');
          try { await api.auth.send(email); setRetryAt(Date.now() + 60_000); }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not resend.'); }
          finally { setSaving(false); }
        }}>{now < retryAt ? `Resend in ${Math.ceil((retryAt - now) / 1000)}s` : 'Resend code'}</button>
        <button type="button" className="btn ghost" disabled={saving} onClick={() => { setSent(false); setCode(''); setError(''); }}>Change email</button>
      </div>}
    </form>
  );
  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={(event) => void submit(event)}>
      {steps && <Steps at={2} />}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-name">Name</label>
          <input id="pf-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={60} required data-autofocus />
        </div>
        <div className="field">
          <label htmlFor="pf-netid">NetID</label>
          <input id="pf-netid" className="input" readOnly value={netId} onChange={(event) => setNetId(event.target.value)} placeholder="abc1234" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={14} required />
        </div>
        <div className="field">
          <label htmlFor="pf-major">Major</label>
          <select id="pf-major" className="input" value={major} onChange={(event) => setMajor(event.target.value)} required>
            <option value="" disabled>
              Select
            </option>
            {MAJORS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pf-year">Year</label>
          <select id="pf-year" className="input" value={classOf} onChange={(event) => setClassOf(Number(event.target.value))}>
            {years.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving' : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface ModalProps {
  open: boolean;
  title: string;
  reason: string;
  onClose(): void;
  onDone(profile: Profile): void;
}

/** The details sheet, opened by whichever page needs a name, NetID, major and year. */
export function ProfileModal({ open, title, reason, onClose, onDone }: ModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={reason || undefined} width={520}>
      <ProfileForm onDone={onDone} />
    </Modal>
  );
}
