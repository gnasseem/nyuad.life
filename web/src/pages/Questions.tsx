import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Answer, type LeaderboardEntry, type PostSummary, type Question, type QuestionWithAnswers, type Redirect } from '../api';
import { EmptyState } from '../components/EmptyState';
import { PostRow } from '../components/PostRow';
import { RedirectCard } from '../components/RedirectCard';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { initials, plural, relativeDate } from '../format';
import { IconBack, IconChat, IconLink } from '../icons';
import { sleep } from '../motion';
import { navigate, onLinkClick } from '../router';
import { askerKey } from '../store';

type Tab = 'ask' | 'help';

interface Props {
  search: URLSearchParams;
}

const QUESTION_MAX = 600;

/** Cmd/Ctrl+Enter submits from any textarea on this page. */
function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submit();
  }
}

export function QuestionsPage({ search }: Props) {
  const { boardProblem } = useApp();
  const tab: Tab = search.get('tab') === 'help' ? 'help' : 'ask';
  const setTab = (next: Tab) => navigate({ name: 'questions' }, { replace: true, search: next === 'help' ? 'tab=help' : '', keepScroll: true });

  return (
    <div className="page">
      <Sign title="Questions" ar="الأسئلة" />
      <div className="tabs-wrap">
        <Segmented variant="tabs" value={tab} onChange={setTab} label="Questions" options={[{ id: 'ask', label: 'Ask' }, { id: 'help', label: 'Answer' }]} />
      </div>
      {boardProblem ? (
        <div className="alert">{boardProblem}</div>
      ) : (
        <div className="split">
          <div className="tab-body" key={tab}>
            {tab === 'ask' ? <AskStudents /> : <HelpOut />}
          </div>
          <aside className="rail">
            <Leaderboard />
          </aside>
        </div>
      )}
    </div>
  );
}

function Leaderboard() {
  const { profile } = useApp();
  const [helpers, setHelpers] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    api.board
      .leaderboard(profile?.netId)
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

function AskStudents() {
  const { profile, boardPrefill, setBoardPrefill, toast } = useApp();
  const [text, setText] = useState(boardPrefill);
  const [name, setName] = useState(profile?.name ?? '');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [posted, setPosted] = useState<{ similar: QuestionWithAnswers[]; related: PostSummary[]; redirect?: Redirect } | null>(null);
  const [mine, setMine] = useState<QuestionWithAnswers[]>([]);
  const [recent, setRecent] = useState<QuestionWithAnswers[]>([]);

  useEffect(() => {
    if (boardPrefill) setBoardPrefill('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (profile && !name) setName(profile.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const loadMine = useCallback(() => {
    api.board
      .mine(askerKey())
      .then((result) => setMine(result.questions))
      .catch(() => setMine([]));
  }, []);

  useEffect(loadMine, [loadMine]);

  useEffect(() => {
    api.board
      .recent()
      .then((result) => setRecent(result.questions))
      .catch(() => setRecent([]));
  }, []);

  const mineIds = new Set(mine.map((entry) => entry.id));
  const others = recent.filter((entry) => !mineIds.has(entry.id) && entry.answers.length > 0).slice(0, 6);

  const ready = text.trim().length >= 12 && !posting;

  const submit = async () => {
    if (!ready) return;
    setError('');
    setPosting(true);
    try {
      const result = await api.board.ask({ text: text.trim(), key: askerKey(), name: name.trim() || undefined });
      setPosted({ similar: result.similar ?? [], related: result.related ?? [], redirect: result.redirect });
      if (result.question) {
        setText('');
        toast('Posted');
        loadMine();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the question.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 30 }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="ask-card">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => submitOnShortcut(event, () => void submit())}
            placeholder="What do you want to ask other students?"
            maxLength={QUESTION_MAX}
            rows={3}
            aria-label="Your question"
          />
          <div className="ask-card-foot">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" maxLength={40} aria-label="Your name (optional)" />
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={!ready}>
              {posting ? 'Posting' : 'Post question'}
            </button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        <p className="page-lede">
          For what Ask couldn't answer. Your question goes to students in the right major and year; their answers show up below, and Ask cites them from then on.
        </p>
      </div>

      {posted?.redirect && <RedirectCard redirect={posted.redirect} />}
      {posted && posted.similar.length > 0 && (
        <div>
          <h2 className="section-title">Already answered</h2>
          <div className="list">
            {posted.similar.map((entry) => (
              <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
            ))}
          </div>
        </div>
      )}
      {posted && posted.related.length > 0 && (
        <div>
          <h2 className="section-title">Related threads</h2>
          <div className="list">
            {posted.related.map((post) => (
              <PostRow key={post.id} post={post} />
            ))}
          </div>
        </div>
      )}
      {mine.length > 0 && (
        <div>
          <h2 className="section-title">
            Your questions
          </h2>
          <div className="list">
            {mine.map((entry) => (
              <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
            ))}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <h2 className="section-title">Recently answered</h2>
          <div className="list">
            {others.map((entry) => (
              <QuestionThread key={entry.id} question={entry} answers={entry.answers} compact />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionThread({ question, answers, compact = false }: { question: Question; answers: Answer[]; compact?: boolean }) {
  const shown = compact ? answers.slice(0, 1) : answers;
  return (
    <div className="qa">
      {compact ? (
        <a className="q" href={`/questions/${question.id}`} onClick={onLinkClick}>
          {question.text}
        </a>
      ) : (
        <div className="q">{question.text}</div>
      )}
      <div className="meta">
        <span className={`pill ${answers.length ? 'tone-ok' : 'tone-warn'}`}>
          <span className="dot" /> {answers.length ? plural(answers.length, 'answer') : 'Open'}
        </span>
        <span>
          {question.askerName ? `${question.askerName}, ` : ''}
          {relativeDate(question.createdAt)}
        </span>
        {question.courses.slice(0, 2).map((code) => (
          <span key={code} className="code">
            {code}
          </span>
        ))}
      </div>
      {shown.length > 0 && (
        <div className="stations qa-answers">
          {shown.map((answer) => (
            <div key={answer.id} className="qa-answer">
              <span className="meta">
                <span className="avatar sm">{initials(answer.helperName)}</span>
                <b>{answer.helperName}</b>
                <span>{answer.helperMajor}</span>
              </span>
              <div className={`text${compact ? ' clamped' : ''}`}>{answer.text}</div>
            </div>
          ))}
        </div>
      )}
      {compact && answers.length > 1 && (
        <a className="link small" href={`/questions/${question.id}`} onClick={onLinkClick}>
          All {answers.length} answers
        </a>
      )}
    </div>
  );
}

function HelpOut() {
  const { profile, setProfile, requestProfile } = useApp();
  const [card, setCard] = useState<{ question: Question | null; remaining: number; answered: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<'answer' | 'skip' | null>(null);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // After an answer or a skip, the next card's box takes the focus; on first load it does not, so phones keep the keyboard down.
  const refocus = useRef(false);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    textareaRef.current?.focus({ preventScroll: true });
  }, [card?.question?.id]);

  const load = useCallback(async () => {
    if (!profile) return;
    setError('');
    try {
      const next = await api.board.next(profile.netId, askerKey());
      setCard(next);
      setText('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_profile') setProfile(null);
      else setError(err instanceof Error ? err.message : 'Could not load a question.');
    }
    // Keyed on the NetID, not the profile: answering bumps the profile's count, which must not fetch a second card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.netId, setProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!profile) {
    return (
      <EmptyState icon={<IconChat />} title="Help other students">
        <button type="button" className="btn primary" onClick={() => void requestProfile()}>
          Add your details
        </button>
      </EmptyState>
    );
  }

  const act = async (kind: 'answer' | 'skip') => {
    if (!card?.question || busy) return;
    if (kind === 'answer' && text.trim().length < 2) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'answer') {
        const result = await api.board.answer({ netId: profile.netId, questionId: card.question.id, text: text.trim() });
        setProfile({ ...profile, answers: result.answered });
      } else await api.board.skip({ netId: profile.netId, questionId: card.question.id });
      setLeaving(kind);
      refocus.current = true;
      await sleep(220);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the answer.');
    } finally {
      setLeaving(null);
      setBusy(false);
    }
  };

  if (!card) {
    return error ? (
      <div className="alert error">{error}</div>
    ) : (
      <div className="status-line">
        <span className="spinner" />
      </div>
    );
  }

  const question = card.question;
  return (
    <div>
      {question ? (
        <div className={`deck${card.remaining > 1 ? ' stacked' : ''}`}>
          <div className={`flashcard${leaving ? ` leaving-${leaving}` : ''}`} key={question.id}>
            <div className="stack" style={{ gap: 12 }}>
              <div className={`question${question.text.length > 140 ? ' long' : ''}`}>{question.text}</div>
              <div className="meta">
                <span>
                  {question.askerName ? `${question.askerName}, ` : ''}
                  {relativeDate(question.createdAt)}
                </span>
                {question.courses.map((code) => (
                  <span key={code} className="code">
                    {code}
                  </span>
                ))}
              </div>
            </div>
            <textarea
              ref={textareaRef}
              className="input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => submitOnShortcut(event, () => void act('answer'))}
              placeholder="Your answer"
              rows={4}
              maxLength={1200}
              aria-label="Your answer"
            />
            {error && <div className="alert error">{error}</div>}
            <div className="flashcard-actions">
              <button type="button" className="btn ghost" onClick={() => void act('skip')} disabled={busy}>
                Skip
              </button>
              <button type="button" className="btn primary" onClick={() => void act('answer')} disabled={busy || text.trim().length < 2}>
                Send answer
              </button>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState icon={<IconChat />} title="All caught up" />
      )}
    </div>
  );
}

export function QuestionPage({ id }: { id: string }) {
  const { toast } = useApp();
  const [data, setData] = useState<{ question: Question; answers: Answer[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    api.board
      .question(id)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this question.'));
  }, [id]);
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
      {data && (
        <div className="list">
          <QuestionThread question={data.question} answers={data.answers} />
        </div>
      )}
    </div>
  );
}
