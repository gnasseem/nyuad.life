import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useApp } from '../context';
import { IconClose } from '../icons';
import { useRoute } from '../router';
import { busyTyping, claimNudge, finishNudge, mayNudge, nudgeShown, visitCount } from '../nudges';
import { loadConversations } from '../store';

const SCORES = [1, 2, 3, 4, 5];
const PROMPT = ['', 'What went wrong?', 'What should work better?', 'What would make it more useful?', 'What would make it a 5?', 'What do you use it for most?'];

/**
 * Now and then, a corner card asking how useful the site is: a score from 1 to 5, then, if they like, one line on what
 * would make it better. It goes to the admins like the feedback form. Only for students who have been back a few times
 * and asked something, at most three weeks apart, and after an answer it stays away for four months.
 */
export function SiteReview() {
  const { profile, toast } = useApp();
  const { route } = useRoute();
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const away = route.name === 'admin' || route.name === 'settings';

  useEffect(() => {
    if (!profile || open || away || visitCount() < 3 || loadConversations().length < 2 || !mayNudge('site')) return;
    const timer = window.setTimeout(() => {
      // Not over an answer still being written or a box being typed in; the next visit can ask instead.
      if (document.querySelector('.turn.model.pending, .cursor') || busyTyping() || !claimNudge('site')) return;
      setOpen(true);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [profile, open, away]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    // Three times unanswered is enough for a long while.
    if (nudgeShown('site') >= 3) finishNudge('site', 120);
  };
  const send = async () => {
    if (!score || sending) return;
    setSending(true);
    try {
      await api.feedback(text.trim() || `Rated nyuad.life ${score}/5.`, window.location.pathname, score);
      finishNudge('site', 120);
      setOpen(false);
      toast(score >= 4 ? 'Thanks. Glad it helps.' : 'Thanks. The admins read every one.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not send it.');
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="review-nudge site-review" data-line="ask" role="dialog" aria-label="Review nyuad.life">
      <button type="button" className="icon-btn" onClick={close} aria-label="Dismiss">
        <IconClose />
      </button>
      <b>How useful is nyuad.life for you?</b>
      <div className="site-score" role="radiogroup" aria-label="Score from 1 to 5">
        {SCORES.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={score === value} className={score === value ? 'on' : undefined} onClick={() => setScore(value)}>
            {value}
          </button>
        ))}
      </div>
      <div className="site-score-ends" aria-hidden="true">
        <span>Not useful</span>
        <span>Can’t do without it</span>
      </div>
      {score && (
        <div className="site-review-more">
          <textarea className="input" rows={2} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} placeholder={`${PROMPT[score]} (optional)`} aria-label="What would make it better" autoFocus />
          <div className="review-nudge-actions">
            <button type="button" className="btn sm primary" onClick={() => void send()} disabled={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
      {!score && (
        <div className="review-nudge-actions">
          <button type="button" className="link-btn" onClick={close}>
            Not now
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              finishNudge('site');
              setOpen(false);
            }}
          >
            Don’t ask again
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
