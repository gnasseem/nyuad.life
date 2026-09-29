import { useState, type FormEvent } from 'react';
import { api, setAccessCode } from '../api';

interface Props {
  onUnlocked(): void;
}

export function AccessGate({ onUnlocked }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    setAccessCode(code.trim());
    try {
      await api.home();
      onUnlocked();
    } catch {
      setAccessCode('');
      setError('That code did not work. Ask whoever shared this app with you.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back">
      <form className="modal" onSubmit={submit}>
        <div>
          <h2 className="display">Students only</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            This archive comes from a private NYUAD group. Enter the access code you were given to continue.
          </p>
        </div>
        <label className="field">
          Access code
          <input autoFocus value={code} onChange={(event) => setCode(event.target.value)} placeholder="e.g. falcons-2026" autoComplete="off" />
        </label>
        {error && <div className="alert">{error}</div>}
        <div className="row end">
          <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  );
}
