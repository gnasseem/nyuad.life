import { useState, type FormEvent } from 'react';
import { api, ApiError, type Profile } from '../api';
import { useApp } from '../context';
import { Modal } from './Modal';
import { classYears, standingFor } from '../year';

export const MAJORS = [
  'Arab Crossroads Studies', 'Art and Art History', 'Bioengineering', 'Biology', 'Business, Organizations and Society', 'Chemistry', 'Civil Engineering',
  'Computer Engineering', 'Computer Science', 'Economics', 'Electrical Engineering', 'Film and New Media', 'General Engineering', 'History',
  'Interactive Media', 'Legal Studies', 'Literature and Creative Writing', 'Mathematics', 'Mechanical Engineering', 'Music', 'Philosophy', 'Physics',
  'Political Science', 'Psychology', 'Social Research and Public Policy', 'Theater', 'Undecided', 'Other',
];

interface FormProps {
  onDone?(profile: Profile): void;
}

/** Name, NetID, major and class year: the four fields everything else on the board hangs off. */
export function ProfileForm({ onDone }: FormProps) {
  const { profile, setProfile } = useApp();
  const years = classYears();
  const [name, setName] = useState(profile?.name ?? '');
  const [netId, setNetId] = useState(profile?.netId ?? '');
  const [major, setMajor] = useState(profile?.major ?? '');
  const [classOf, setClassOf] = useState<number>(profile?.classOf ?? years[1]!.value);
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
      onDone?.(result.profile);
    } catch (err) {
      // A server without a working board must not stop anyone using the rest of the site: keep the profile on the device.
      if (err instanceof ApiError && err.status === 503 && /^[a-z]{1,8}\d{1,6}$/.test(draft.netId) && draft.name.length >= 2 && draft.major) {
        const local: Profile = { ...draft, year: standingFor(classOf), answers: profile?.answers ?? 0 };
        setProfile(local);
        onDone?.(local);
      } else setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 16 }} onSubmit={(event) => void submit(event)}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-name">Name</label>
          <input id="pf-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={60} placeholder="What people call you" required />
        </div>
        <div className="field">
          <label htmlFor="pf-netid">NetID</label>
          <input id="pf-netid" className="input" value={netId} onChange={(event) => setNetId(event.target.value)} placeholder="abc1234" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={14} required />
        </div>
        <div className="field">
          <label htmlFor="pf-major">Major</label>
          <select id="pf-major" className="input" value={major} onChange={(event) => setMajor(event.target.value)} required>
            <option value="" disabled>
              Choose
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
      {error && <div className="alert">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 2 }}>
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving' : 'Save'}
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

/** The one-time "who are you" step, as a sheet over whatever page asked for it. */
export function ProfileModal({ open, title, reason, onClose, onDone }: ModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={reason} width={540}>
      <ProfileForm onDone={onDone} />
    </Modal>
  );
}
