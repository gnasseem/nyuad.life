import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Answer, type FeedQuestion, type LeaderboardEntry, type PostSummary, type QuestionWithAnswers, type Redirect } from '../api';
import { AdminRemove, onAdminRemoved } from '../components/AdminRemove';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { PostRow } from '../components/PostRow';
import { RedirectCard } from '../components/RedirectCard';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { initials, plural, relativeDate } from '../format';
import { IconBack, IconChat, IconLink, IconPlus, IconSearch } from '../icons';
import { navigate, onLinkClick } from '../router';
import { askerKey, loadSeenAnswers, saveSeenAnswers } from '../store';

const QUESTION_MAX = 600;
const ANSWER_MAX = 1200;

type Filter = 'all' | 'for-you' | 'open' | 'answered' | 'mine';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'for-you', label: 'For you' },
  { id: 'open', label: 'Needs an answer' },
  { id: 'answered', label: 'Answered' },
  { id: 'mine', label: 'Yours' },
];

/** Cmd/Ctrl+Enter submits from any textarea on this page. */
function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submit();
  }
}

/**
 * The questions students asked each other, newest first, with their answers: everyone sees the feed, anyone can
 * answer from it, and the + button asks a new one. Answered questions are cited by Ask from then on.
 */
export function QuestionsPage(_props: { search: URLSearchParams }) {
  const { boardProblem, boardPrefill, setBoardPrefill, profile } = useApp();
  const [questions, setQuestions] = useState<FeedQuestion[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [prefill, setPrefill] = useState('');

  const load = useCallback(() => {
    if (boardProblem) return;
    api.board
      .feed()
      .then((result) => {
        setQuestions(result.questions);
        // Your questions' answers are on screen here, so the home page stops pointing them out.
        const seen = loadSeenAnswers();
        for (const question of result.questions) if (question.mine) seen[question.id] = question.answers.length;
        saveSeenAnswers(seen);
        setMore(result.more);
        setCursor(result.next);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the questions.'));
  }, [boardProblem]);

  useEffect(load, [load]);
  useEffect(() => onAdminRemoved(load), [load]);
  useEffect(() => {
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // A question carried over from Ask ("Ask students") opens the ask sheet with it filled in.
  useEffect(() => {
    if (!boardPrefill) return;
    setPrefill(boardPrefill);
    setAsking(true);
    setBoardPrefill('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.board.feed(cursor);
      setQuestions((current) => [...(current ?? []), ...result.questions.filter((entry) => !current?.some((known) => known.id === entry.id))]);
      setMore(result.more);
      setCursor(result.next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  const answered = (questionId: string, answer: Answer) =>
    setQuestions((current) => current?.map((entry) => (entry.id === questionId ? { ...entry, answers: [...entry.answers, answer], status: 'answered' } : entry)) ?? null);

  const shown = (questions ?? []).filter((entry) => {
    if (query.trim() && !`${entry.text} ${entry.summary} ${entry.answers.map((answer) => answer.text).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (entry.status === 'closed') return false;
    if (filter === 'open') return entry.answers.length === 0;
    if (filter === 'answered') return entry.answers.length > 0;
    if (filter === 'mine') return entry.mine;
    if (filter === 'for-you') return !entry.mine && !entry.byMe && entry.answers.length < 3 && ((!entry.majors.length && !entry.years.length) || (profile ? entry.majors.includes(profile.major) || entry.years.includes(profile.year) : false));
    return true;
  }).sort((a, b) => {
    const score = (entry: FeedQuestion) => {
      const need = entry.answers.length === 0 ? 10 : entry.answers.length < 3 ? 3 : 0;
      const fit = profile ? (entry.majors.includes(profile.major) ? 3 : 0) + (entry.years.includes(profile.year) ? 2 : 0) : 0;
      const waiting = Math.min(2, Math.max(0, (Date.now() - Date.parse(entry.createdAt)) / 86_400_000) / 7);
      return need + fit + (entry.answers.length === 0 ? waiting : 0) - (entry.mine ? 2 : 0);
    };
    return score(b) - score(a) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
  const openCount = (questions ?? []).filter((entry) => entry.answers.length === 0).length;

  return (
    <div className="page">
      <Sign title="Questions" ar="الأسئلة" sub="What Ask could not answer, answered by students. Unanswered ones come first, with a lift for your major and year.">
        <button type="button" className="btn primary" onClick={() => setAsking(true)}>
          <IconPlus /> Ask students
        </button>
      </Sign>
      {boardProblem ? (
        <div className="alert">{boardProblem}</div>
      ) : (
        <div className="split">
          <div className="feed">
            <div className="search-field feed-search">
              <IconSearch />
              <input id="question-search" className="input" type="search" placeholder="Search questions and answers" aria-label="Search questions and answers" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="chips scroll-x feed-filters" role="radiogroup" aria-label="Show">
              {FILTERS.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={filter === entry.id} className={`chip${filter === entry.id ? ' on' : ''}`} onClick={() => setFilter(entry.id)}>
                  {entry.label}
                  {entry.id === 'open' && openCount > 0 && <span className="n">{openCount}</span>}
                </button>
              ))}
            </div>
            {error && <div className="alert error">{error}</div>}
            {!questions && !error && (
              <div className="stack" aria-busy="true">
                <div className="skeleton" style={{ height: 150 }} />
                <div className="skeleton" style={{ height: 110 }} />
                <div className="skeleton" style={{ height: 110 }} />
              </div>
            )}
            {questions && shown.length === 0 && (
              <EmptyState icon={<IconChat />} title={query.trim() ? 'No matching questions' : filter === 'mine' ? 'You have not asked anything yet' : filter === 'open' ? 'Every question has an answer' : filter === 'for-you' ? 'Nothing matched you yet' : 'No questions here yet'} text={query.trim() ? 'Try a different phrase or clear your search.' : filter === 'for-you' ? 'Other students may still need an answer.' : 'Ask what the archive could not answer: students in the right major and year see it first.'}>
                <button type="button" className="btn primary" onClick={() => query.trim() ? setQuery('') : filter === 'for-you' ? setFilter('open') : setAsking(true)}>
                  {query.trim() ? 'Clear search' : filter === 'for-you' ? 'See questions needing help' : <><IconPlus /> Ask a question</>}
                </button>
              </EmptyState>
            )}
            {shown.length > 0 && (
              <div className="feed-list">
                {shown.map((entry) => (
                  <QuestionCard key={entry.id} question={entry} onAnswered={(answer) => answered(entry.id, answer)} />
                ))}
              </div>
            )}
            {more && filter === 'all' && (
              <div className="load-more">
                <button type="button" className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading' : 'Older questions'}
                </button>
              </div>
            )}
          </div>
          <aside className="rail">
            <Leaderboard />
            <div className="rail-block">
              <h2>How it works</h2>
              <p className="page-lede">Ask with the + button. Your question goes into this feed, first to students in the right major and year. Their answers appear under it, and Ask cites them from then on.</p>
            </div>
          </aside>
        </div>
      )}
      {!boardProblem && (
        <button type="button" className="fab" onClick={() => setAsking(true)} aria-label="Ask a question" title="Ask a question">
          <IconPlus />
        </button>
      )}
      <AskSheet
        open={asking}
        initial={prefill}
        onClose={() => {
          setAsking(false);
          setPrefill('');
        }}
        onPosted={(question) => setQuestions((current) => [{ ...question, mine: true }, ...(current ?? []).filter((entry) => entry.id !== question.id)])}
      />
    </div>
  );
}

function Leaderboard() {
  const { profile } = useApp();
  const [helpers, setHelpers] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    api.board
      .leaderboard()
      .then((result) => setHelpers(result.helpers))
      .catch(() => setHelpers([]));
  }, [profile?.answers]);
  if (helpers.length === 0) return null;
  return (
    <div className="rail-block">
      <h2>Top helpers</h2>
      <div className="lb">
        {helpers.map((entry, index) => (
          <div key={entry.id} className={`lb-row${entry.me ? ' me' : ''}`}>
            <span className="rank">{index + 1}</span>
            <span className="who">
              <b>{entry.name}</b>
              <span>{entry.major}</span>
            </span>
            <span className="n">{plural(entry.answers, 'answer')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The sheet the + button opens: write the question, post it, and see right away what was already answered. */
function AskSheet({ open, initial, onClose, onPosted }: { open: boolean; initial: string; onClose(): void; onPosted(question: FeedQuestion): void }) {
  const { profile, toast } = useApp();
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [posted, setPosted] = useState<{ similar: QuestionWithAnswers[]; related: PostSummary[]; redirect?: Redirect } | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(initial);
    setError('');
    setPosted(null);
  }, [open, initial]);

  const ready = text.trim().length >= 12 && !posting;
  const submit = async () => {
    if (!ready) return;
    setError('');
    setPosting(true);
    try {
      const result = await api.board.ask({ text: text.trim(), key: askerKey(), name: anonymous ? undefined : profile?.name.split(' ')[0] });
      if (result.question) {
        onPosted({ ...result.question, answers: [] });
        toast('Posted to the feed');
        setText('');
      }
      const found = { similar: result.similar ?? [], related: result.related ?? [], redirect: result.redirect };
      if (found.similar.length || found.related.length || found.redirect) setPosted(found);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the question.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={posted ? 'Posted. Meanwhile…' : 'Ask students'} subtitle={posted ? undefined : 'For what Ask could not answer. Students in the right major and year see it first.'} width={600}>
      {posted ? (
        <div className="stack" style={{ gap: 18 }}>
          {posted.redirect && <RedirectCard redirect={posted.redirect} />}
          {posted.similar.length > 0 && (
            <div>
              <h3 className="section-title">Already answered</h3>
              <div className="list">
                {posted.similar.map((entry) => (
                  <QuestionCard key={entry.id} question={entry} compact />
                ))}
              </div>
            </div>
          )}
          {posted.related.length > 0 && (
            <div>
              <h3 className="section-title">Related threads</h3>
              <div className="list">
                {posted.related.map((post) => (
                  <PostRow key={post.id} post={post} />
                ))}
              </div>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="ask-card">
            <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => submitOnShortcut(event, () => void submit())} placeholder="What do you want to ask other students?" maxLength={QUESTION_MAX} rows={4} aria-label="Your question" data-autofocus />
            <div className="ask-card-foot">
              <label className="check">
                <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /> Ask without my name
              </label>
              <span className="faint small">{text.trim().length < 12 ? `${12 - text.trim().length} more characters` : `${QUESTION_MAX - text.length} left`}</span>
              <button type="button" className="btn primary" onClick={() => void submit()} disabled={!ready}>
                {posting ? 'Posting' : 'Post question'}
              </button>
            </div>
          </div>
          {error && <div className="alert error">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

/** One question with its answers, and a box to answer it unless it is yours. */
function QuestionCard({ question, onAnswered, compact = false }: { question: FeedQuestion; onAnswered?(answer: Answer): void; compact?: boolean }) {
  const { profile, setProfile, toast } = useApp();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const answers = question.answers.filter((answer) => !removed.has(answer.id));
  const shown = compact || expanded ? answers : answers.slice(0, 2);
  const open = answers.length === 0;

  useEffect(() => {
    if (writing) boxRef.current?.focus({ preventScroll: false });
  }, [writing]);

  const send = async () => {
    if (!profile || text.trim().length < 2 || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.answer({ netId: profile.netId, questionId: question.id, text: text.trim() });
      setProfile({ ...profile, answers: result.answered });
      onAnswered?.(result.answer);
      setText('');
      setWriting(false);
      toast('Thanks for answering');
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not send the answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`qcard${open ? ' open' : ''}`}>
      <div className="qcard-head">
        <span className={`pill ${open ? 'tone-warn' : 'tone-ok'}`}>
          <span className="dot" /> {open ? 'Needs an answer' : plural(answers.length, 'answer')}
        </span>
        <span className="faint small">
          {question.askerName ? `${question.askerName}, ` : ''}
          {relativeDate(question.createdAt)}
        </span>
        {question.mine && <span className="pill tone-line">Yours</span>}
        <span className="spacer" />
        <AdminRemove type="question" id={question.id} label={question.text} compact />
      </div>
      <a className="q" href={`/questions/${question.id}`} onClick={onLinkClick}>
        {question.text}
      </a>
      {question.courses.length > 0 && (
        <div className="meta">
          {question.courses.slice(0, 3).map((code) => (
            <span key={code} className="code">
              {code}
            </span>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className="stations in-plate qa-answers">
          {shown.map((answer) => (
            <div key={answer.id} className="qa-answer">
              <span className="meta">
                <span className="avatar sm">{initials(answer.helperName)}</span>
                <b>{answer.helperName}</b>
                <span>{answer.helperMajor}</span>
                <span>{relativeDate(answer.createdAt)}</span>
                <AdminRemove type="answer" id={answer.id} label={answer.text} compact onRemoved={() => setRemoved((current) => new Set(current).add(answer.id))} />
              </span>
              <div className="text">{answer.text}</div>
            </div>
          ))}
        </div>
      )}
      {!compact && answers.length > shown.length && (
        <button type="button" className="link-btn small" onClick={() => setExpanded(true)}>
          Show all {answers.length} answers
        </button>
      )}
      {!compact && !question.mine && question.byMe !== 'answer' && profile && (
        <div className="qcard-answer">
          {writing ? (
            <>
              <textarea ref={boxRef} className="input" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => submitOnShortcut(event, () => void send())} placeholder="What you know: be specific, and say when it was" rows={3} maxLength={ANSWER_MAX} aria-label="Your answer" />
              {error && <div className="alert error">{error}</div>}
              <div className="row-flex between">
                <button type="button" className="btn ghost sm" onClick={() => setWriting(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary sm" onClick={() => void send()} disabled={busy || text.trim().length < 2}>
                  {busy ? 'Sending' : 'Send answer'}
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn sm" onClick={() => setWriting(true)}>
              <IconChat /> {open ? 'Answer this' : 'Add an answer'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function QuestionPage({ id }: { id: string }) {
  const { toast } = useApp();
  const [data, setData] = useState<FeedQuestion | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    api.board
      .question(id)
      .then((result) => setData({ ...result.question, answers: result.answers }))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this question.'));
  }, [id]);
  useEffect(() => onAdminRemoved(() => navigate({ name: 'questions' })), []);
  return (
    <div className="page narrow">
      <div className="back-row">
        <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'questions' })}>
          <IconBack /> Questions
        </button>
        {data && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              navigator.clipboard.writeText(window.location.href).then(
                () => toast('Link copied'),
                () => toast('Could not copy'),
              );
            }}
          >
            <IconLink /> Copy link
          </button>
        )}
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <div className="skeleton" style={{ height: 160 }} aria-busy="true" />}
      {data && <QuestionCard question={data} onAnswered={(answer) => setData((current) => (current ? { ...current, answers: [...current.answers, answer] } : current))} />}
    </div>
  );
}
