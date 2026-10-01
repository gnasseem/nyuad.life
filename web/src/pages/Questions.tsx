import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Answer, type LeaderboardEntry, type PostSummary, type Question, type QuestionWithAnswers, type Redirect } from '../api';
import { PostRow } from '../components/PostRow';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { initials, plural, relativeDate, standingLabel, topicLabel } from '../format';
import { IconBack } from '../icons';
import { navigate } from '../router';
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
      <div className="page-head">
        <h1>Questions</h1>
        <Segmented value={tab} onChange={setTab} label="Questions" options={[{ id: 'ask', label: 'Ask' }, { id: 'help', label: 'Answer' }]} />
      </div>
      {boardProblem ? (
        <div className="alert">{boardProblem}</div>
      ) : tab === 'ask' ? (
        <AskStudents />
      ) : (
        <>
          <HelpOut />
          <Leaderboard />
        </>
      )}
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
    <>
      <h2 className="section-title">Top helpers</h2>
      <div className="list">
        {helpers.map((entry, index) => (
          <div key={entry.netId} className={`lb-row${profile?.netId === entry.netId ? ' me' : ''}`}>
            <span className="rank">{index + 1}</span>
            <span className="who">
              <b>{entry.name}</b>
              <span>
                {entry.major}, {standingLabel(entry.year)}
              </span>
            </span>
            <span className="n">{plural(entry.answers, 'answer')}</span>
          </div>
        ))}
      </div>
    </>
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
    <div className="stack" style={{ gap: 28 }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="ask-card">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => submitOnShortcut(event, () => void submit())}
            placeholder="Your question. Name the course, building or office."
            maxLength={QUESTION_MAX}
            rows={3}
            aria-label="Your question"
          />
          <div className="bar">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" maxLength={40} aria-label="Your name" />
            <span className="count">
              {text.length}/{QUESTION_MAX}
            </span>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={!ready}>
              {posting ? 'Posting' : 'Post'}
            </button>
          </div>
        </div>
        <p className="faint small">Anonymous unless you add a name. Goes to students in the majors and years most likely to know.</p>
        {error && <div className="alert error">{error}</div>}
      </div>

      {posted?.redirect && (
        <div className="redirect">
          <h3>{posted.redirect.title}</h3>
          <p>{posted.redirect.message}</p>
          <a className="btn primary sm" href={posted.redirect.link.url} target={posted.redirect.link.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
            {posted.redirect.link.label}
          </a>
        </div>
      )}
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
          <h2 className="section-title">Your questions</h2>
          <div className="list">
            {mine.map((entry) => (
              <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionThread({ question, answers }: { question: Question; answers: Answer[] }) {
  return (
    <div className="qa">
      <div className="q">{question.text}</div>
      <div className="meta">
        <span className={`pill ${answers.length ? 'k-ok' : 'k-warn'}`}>
          <span className="dot" /> {answers.length ? plural(answers.length, 'answer') : `Open, seen by ${question.views}`}
        </span>
        <span>
          {question.askerName ? `${question.askerName}, ` : ''}
          {relativeDate(question.createdAt)}
        </span>
        {question.topics.slice(0, 2).map((topic) => (
          <span key={topic} className="tag">
            {topicLabel(topic)}
          </span>
        ))}
        {question.courses.slice(0, 2).map((code) => (
          <span key={code} className="tag course">
            {code}
          </span>
        ))}
      </div>
      {answers.map((answer) => (
        <div key={answer.id} className="qa-answer">
          <span className="meta">
            <span className="avatar sm">{initials(answer.helperName)}</span>
            <b>{answer.helperName}</b>
            <span>
              {answer.helperMajor}, {standingLabel(answer.helperYear)}, {relativeDate(answer.createdAt)}
            </span>
          </span>
          <div className="text">{answer.text}</div>
        </div>
      ))}
    </div>
  );
}

function HelpOut() {
  const { profile, setProfile, requestProfile } = useApp();
  const [card, setCard] = useState<{ question: Question | null; remaining: number; answered: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    setError('');
    try {
      const next = await api.board.next(profile.netId);
      setCard(next);
      setText('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_profile') setProfile(null);
      else setError(err instanceof Error ? err.message : 'Could not load a question.');
    }
  }, [profile, setProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!profile) {
    return (
      <div className="invite">
        <h2>Answer questions from other students</h2>
        <p>Questions are matched to you by major and year. Your name appears next to your answers.</p>
        <button type="button" className="btn primary lg" onClick={() => void requestProfile({ title: 'Your details', reason: 'Questions are matched by major and year. Your name appears next to your answers.' })}>
          Add your details
        </button>
      </div>
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
      await load();
      textareaRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the answer.');
    } finally {
      setBusy(false);
    }
  };

  if (!card) {
    return error ? (
      <div className="alert error">{error}</div>
    ) : (
      <div className="status-line">
        <span className="spinner" /> Finding a question
      </div>
    );
  }

  const question = card.question;
  return (
    <div>
      <div className="deck-head">
        <span>{question ? <><b>{plural(card.remaining, 'question')}</b> waiting</> : 'Nothing waiting for you right now'}</span>
        <span>
          <b>{card.answered}</b> answered by you
        </span>
      </div>
      {question ? (
        <div className="flashcard" key={question.id}>
          <div className="stack" style={{ gap: 10 }}>
            <div className={`question${question.text.length > 140 ? ' long' : ''}`}>{question.text}</div>
            <div className="meta">
              <span>
                {question.askerName ? `${question.askerName}, ` : ''}
                {relativeDate(question.createdAt)}
              </span>
              {question.topics.map((topic) => (
                <span key={topic} className="tag">
                  {topicLabel(topic)}
                </span>
              ))}
              {question.courses.map((code) => (
                <span key={code} className="tag course">
                  {code}
                </span>
              ))}
              {(question.majors.length > 0 || question.years.length > 0) && <span className="tag">For {[...question.majors, ...question.years.map(standingLabel)].join(', ')}</span>}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            className="input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => submitOnShortcut(event, () => void act('answer'))}
            placeholder="Your answer. Say what you did and when."
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
      ) : (
        <div className="empty">New questions appear here as students ask them.</div>
      )}
    </div>
  );
}

export function QuestionPage({ id }: { id: string }) {
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
    <div className="page">
      <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'questions' })}>
        <IconBack /> Questions
      </button>
      {error && <div className="alert error">{error}</div>}
      {data && (
        <div className="list">
          <QuestionThread question={data.question} answers={data.answers} />
        </div>
      )}
    </div>
  );
}
