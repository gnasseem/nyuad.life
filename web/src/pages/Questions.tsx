import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Answer, type PostSummary, type Question, type QuestionWithAnswers, type Redirect } from '../api';
import { PostCard } from '../components/PostCard';
import { ProfileGate } from '../components/ProfileGate';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { plural, relativeDate, standingLabel, topicLabel } from '../format';
import { IconBack, IconSkip } from '../icons';
import { navigate } from '../router';
import { askerKey } from '../store';

type Tab = 'ask' | 'help';

interface Props {
  search: URLSearchParams;
}

export function QuestionsPage({ search }: Props) {
  const { health } = useApp();
  const tab: Tab = search.get('tab') === 'help' ? 'help' : 'ask';
  const setTab = (next: Tab) => navigate({ name: 'questions' }, { replace: true, search: next === 'help' ? 'tab=help' : '', keepScroll: true });
  const unavailable = health && !health.board.configured;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Questions</h1>
          <p>When the archive falls short, ask people. Answers come from students who chose to help.</p>
        </div>
        <Segmented value={tab} onChange={setTab} label="Questions" options={[{ id: 'ask', label: 'Ask students' }, { id: 'help', label: 'Answer questions' }]} />
      </div>
      {unavailable ? <div className="alert note">The board is not set up on this server yet, so questions cannot be posted or answered here for now.</div> : tab === 'ask' ? <AskStudents /> : <HelpOut />}
    </div>
  );
}

/* ---------- Ask students ---------- */

function AskStudents() {
  const { profile, boardPrefill, setBoardPrefill } = useApp();
  const [text, setText] = useState(boardPrefill);
  const [name, setName] = useState(profile?.name ?? '');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [posted, setPosted] = useState<{ question?: Question; similar: QuestionWithAnswers[]; related: PostSummary[]; redirect?: Redirect } | null>(null);
  const [mine, setMine] = useState<QuestionWithAnswers[] | null>(null);

  useEffect(() => {
    if (boardPrefill) setBoardPrefill('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMine = useCallback(() => {
    api.board
      .mine(askerKey())
      .then((result) => setMine(result.questions))
      .catch(() => setMine([]));
  }, []);

  useEffect(loadMine, [loadMine]);

  const submit = async () => {
    setError('');
    setPosting(true);
    try {
      const result = await api.board.ask({ text: text.trim(), key: askerKey(), name: name.trim() || undefined });
      setPosted({ question: result.question, similar: result.similar ?? [], related: result.related ?? [], redirect: result.redirect });
      if (result.question) {
        setText('');
        loadMine();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post that.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="card stack" style={{ gap: 14 }}>
        <div className="field">
          <label htmlFor="q-text">Your question</label>
          <textarea id="q-text" className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="Be specific: the course, the building, the office, the year." maxLength={600} rows={4} />
        </div>
        <div className="row wrap between">
          <div className="field" style={{ flex: '1 1 200px' }}>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your first name (optional)" maxLength={40} aria-label="Your name" />
          </div>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={posting || text.trim().length < 12}>
            {posting ? 'Posting' : 'Post question'}
          </button>
        </div>
        {error && <div className="alert">{error}</div>}
      </div>

      {posted?.redirect && (
        <div className="redirect">
          <h3>{posted.redirect.title}</h3>
          <p>{posted.redirect.message}</p>
          <div className="row">
            <a className="btn primary" href={posted.redirect.link.url} target="_blank" rel="noreferrer">
              {posted.redirect.link.label}
            </a>
          </div>
        </div>
      )}
      {posted?.question && (
        <div className="stack">
          <div className="alert note">Posted. It will be shown to students who can answer it; check back here for replies.</div>
          {posted.similar.length > 0 && (
            <>
              <h2 className="section-title" style={{ marginTop: 10 }}>
                Already answered on the board
              </h2>
              {posted.similar.map((entry) => (
                <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
              ))}
            </>
          )}
          {posted.related.length > 0 && (
            <>
              <h2 className="section-title" style={{ marginTop: 10 }}>
                Threads in the archive that may help
              </h2>
              <div className="post-list">
                {posted.related.map((post) => (
                  <PostCard key={post.id} post={post} showSnippet={false} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {mine && mine.length > 0 && (
        <div>
          <h2 className="section-title">Your questions</h2>
          {mine.map((entry) => (
            <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
          ))}
        </div>
      )}
    </div>
  );
}

export function QuestionThread({ question, answers, single }: { question: Question; answers: Answer[]; single?: boolean }) {
  return (
    <div className={`qa${single ? ' single' : ''}`}>
      <div className="q">{question.text}</div>
      <div className="status">
        {answers.length === 0 ? `Waiting for an answer · seen by ${plural(question.views, 'student')}` : plural(answers.length, 'answer')} · {relativeDate(question.createdAt)}
      </div>
      {answers.map((answer) => (
        <div key={answer.id} className="qa-answer">
          <div className="by">
            <b>{answer.helperName}</b> · {answer.helperMajor}, {standingLabel(answer.helperYear)} · {relativeDate(answer.createdAt)}
          </div>
          <div className="text">{answer.text}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Answer questions ---------- */

function HelpOut() {
  const { profile, setProfile } = useApp();
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
    return <ProfileGate title="Before you answer" reason="Questions get routed to the right people by major and year, and your name appears next to what you write. One time only." />;
  }

  const act = async (kind: 'answer' | 'skip') => {
    if (!card?.question) return;
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
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  if (!card) return <div className="status-line">{error ? <span className="alert">{error}</span> : <span className="spinner" />}</div>;

  const question = card.question;
  return (
    <div>
      <div className="progress">
        <span>{question ? `${plural(card.remaining, 'question')} waiting for you` : 'Nothing waiting for you'}</span>
        <span>You have answered {card.answered}</span>
      </div>
      {question ? (
        <div className="flashcard">
          <div className="stack" style={{ gap: 8 }}>
            {question.text.length <= 140 ? <h2>{question.text}</h2> : <h2>{question.summary || 'A question for you'}</h2>}
            {question.text.length > 140 && <div className="question-text">{question.text}</div>}
            <div className="who-for">
              <span>
                {question.askerName ? `${question.askerName} asked` : 'Asked'} {relativeDate(question.createdAt)}
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
              {(question.majors.length > 0 || question.years.length > 0) && <span>for {[...question.majors, ...question.years.map(standingLabel)].join(', ')}</span>}
            </div>
          </div>
          <textarea ref={textareaRef} className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="A few honest sentences are plenty." rows={4} maxLength={1200} aria-label="Your answer" />
          {error && <div className="alert">{error}</div>}
          <div className="flashcard-actions">
            <button type="button" className="btn ghost" onClick={() => void act('skip')} disabled={busy}>
              <IconSkip /> Skip
            </button>
            <button type="button" className="btn primary" onClick={() => void act('answer')} disabled={busy || text.trim().length < 2}>
              Send answer
            </button>
          </div>
        </div>
      ) : (
        <div className="empty">
          <h3>All caught up</h3>
          New questions will show up here. Thanks for helping.
        </div>
      )}
    </div>
  );
}

/* ---------- One question, with its answers ---------- */

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
    <div className="content">
      <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'questions' })}>
        <IconBack /> Questions
      </button>
      {error && <div className="alert">{error}</div>}
      {data && <QuestionThread question={data.question} answers={data.answers} single />}
    </div>
  );
}
