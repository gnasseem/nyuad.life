import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp } from '../context';
import { classYears } from '../year';

export const MAJORS = [
  'Arab Crossroads Studies', 'Art and Art History', 'Bioengineering', 'Biology', 'Business, Organizations and Society', 'Chemistry', 'Civil Engineering',
  'Computer Engineering', 'Computer Science', 'Economics', 'Electrical Engineering', 'Film and New Media', 'General Engineering', 'History',
  'Interactive Media', 'Legal Studies', 'Literature and Creative Writing', 'Mathematics', 'Mechanical Engineering', 'Music', 'Philosophy', 'Physics',
  'Political Science', 'Psychology', 'Social Research and Public Policy', 'Theater', 'Undecided', 'Other',
];

interface Props {
  title: string;
  reason: string;
  onDone?(): void;
}

/** The one-time "who are you" step before answering questions or posting announcements. */
export function ProfileGate({ title, reason, onDone }: Props) {
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
    try {
      const result = await api.board.profile({ netId: netId.trim(), name: name.trim(), major, classOf });
      setProfile(result.profile);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="gate" onSubmit={(event) => void submit(event)}>
      <div>
        <h2>{title}</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          {reason}
        </p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-name">Name</label>
          <input id="pf-name" className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={60} required />
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
      <div className="row">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
