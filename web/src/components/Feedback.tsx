import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

export function Feedback({ toast }: { toast(message: string): void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await api.feedback(message.trim(), window.location.pathname);
      setMessage('');
      setOpen(false);
      toast('Feedback sent to the admins');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not send feedback.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="feedback-btn" onClick={() => setOpen(true)}>Feedback</button>
      <Modal open={open} onClose={() => !sending && setOpen(false)} title="Send feedback" subtitle="Your message goes directly to the site admins.">
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="site-feedback">What should we know?</label>
            <textarea id="site-feedback" className="input" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} rows={5} required placeholder="Share an idea, report a problem, or tell us what could be better." />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn sm ghost" onClick={() => setOpen(false)} disabled={sending}>Cancel</button>
            <button type="submit" className="btn sm primary" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send feedback'}</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
