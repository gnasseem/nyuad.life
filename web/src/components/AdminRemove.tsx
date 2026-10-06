import { useState } from 'react';
import { api, type AdminTarget } from '../api';
import { useApp } from '../context';
import { IconShield, IconTrash } from '../icons';
import { Modal } from './Modal';

/** Fired on window after an admin removes a post, so whichever page lists it can load again. */
export const REMOVED_EVENT = 'ror:removed';

/** Calls `reload` whenever an admin removes a post anywhere on the page. */
export function onAdminRemoved(reload: () => void): () => void {
  window.addEventListener(REMOVED_EVENT, reload);
  return () => window.removeEventListener(REMOVED_EVENT, reload);
}

const NOUN: Record<AdminTarget, string> = { question: 'question', answer: 'answer', notice: 'notice', listing: 'listing', offer: 'offer' };

/**
 * In admin mode, a remove button on any post: remove it, or remove it and bar whoever wrote it from posting again.
 * Renders nothing for everyone else.
 */
export function AdminRemove({ type, id, label, onRemoved, compact = false }: { type: AdminTarget; id: string; label?: string; onRemoved?(): void; compact?: boolean }) {
  const { admin, toast, refreshAdmin } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'remove' | 'ban' | null>(null);
  const [error, setError] = useState('');
  if (!admin) return null;

  const remove = async (ban: boolean) => {
    setBusy(ban ? 'ban' : 'remove');
    setError('');
    try {
      const result = await api.admin.remove({ type, id, ban, reason: reason.trim() || undefined });
      setOpen(false);
      onRemoved?.();
      window.dispatchEvent(new CustomEvent(REMOVED_EVENT, { detail: { type, id } }));
      toast(result.banned ? `Removed, and ${result.banned} is barred from posting` : `${NOUN[type][0]!.toUpperCase()}${NOUN[type].slice(1)} removed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove it.';
      setError(message);
      if (/admin mode is off/i.test(message)) refreshAdmin();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className={`admin-remove${compact ? ' compact' : ''}`} onClick={() => setOpen(true)} title={`Remove this ${NOUN[type]} (admin)`} aria-label={`Remove this ${NOUN[type]} (admin)`}>
        <IconShield />
        {!compact && <span>Remove</span>}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Remove this ${NOUN[type]}?`} subtitle={label ? `"${label.length > 120 ? `${label.slice(0, 120)}…` : label}"` : undefined} width={460}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor={`reason-${id}`}>Reason (kept in the admin log)</label>
            <input id={`reason-${id}`} className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder="Spam, fake event, harassment…" />
          </div>
          {type === 'question' && <p className="muted small">Its answers are removed with it.</p>}
          {error && <div className="alert error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => void remove(true)} disabled={busy !== null}>
              {busy === 'ban' ? 'Removing' : 'Remove and bar the writer'}
            </button>
            <button type="button" className="btn primary danger-fill" onClick={() => void remove(false)} disabled={busy !== null}>
              <IconTrash /> {busy === 'remove' ? 'Removing' : 'Remove'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
