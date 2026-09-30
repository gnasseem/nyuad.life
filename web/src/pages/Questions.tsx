import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Answer, type PostSummary, type Question, type QuestionWithAnswers, type Redirect } from '../api';
import { Mark } from '../components/Logo';
import { PostCard } from '../components/PostCard';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { initials, plural, relativeDate, standingLabel, topicLabel } from '../format';
import { IconBack, IconCheck, IconInfo, IconSkip } from '../icons';
import { navigate } from '../router';
import { askerKey } from '../store';

type Tab = 'ask' | 'help';

interface Props {
  search: URLSearchParams;
}

interface BoardStats {
  open: number;
  answered: number;
  answers: number;
  helpers: number;
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
  const [stats, setStats] = useState<BoardStats | null>(null);

  const refreshStats = useCallback(() => {
    if (boardProblem) return;
    api.board
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [boardProblem]);

  useEffect(refreshStats, [refreshStats]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Questions</h1>
          <p>When the archive falls short, ask people. Questions reach the majors and years best placed to answer, one card at a time.</p>
        </div>
        <Segmented value={tab} onChange={setTab} label="Questions" options={[{ id: 'ask', label: 'Ask students' }, { id: 'help', label: 'Answer', count: stats?.open }]} />
      </div>
      {stats && (
        <div className="stats board-stats">
          <div className="stat hot">
            <b>{stats.open}</b>
            <span>{stats.open === 1 ? 'open question' : 'open questions'}</span>
          </div>
          <div className="stat">
            <b>{stats.answers}</b>
            <span>{stats.answers === 1 ? 'answer written' : 'answers written'}</span>
          </div>
          <div className="stat">
            <b>{stats.helpers}</b>
            <span>{stats.helpers === 1 ? 'student helping' : 'students helping'}</span>
          </div>
        </div>
      )}
      {boardProblem ? (
        <div className="alert warn">
          <IconInfo /> <span>{boardProblem}</span>
        </div>
      ) : tab === 'ask' ? (
        <AskStudents onPosted={refreshStats} />
      ) : (
        <HelpOut onChange={refreshStats} />
      )}
    </div>
  );
}

/* ---------- Ask students ---------- */

function AskStudents({ onPosted }: { onPosted(): void }) {
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
      setPosted({ question: result.question, similar: result.similar ?? [], related: result.related ?? [], redirect: result.redirect });
      if (result.question) {
        setText('');
        loadMine();
        onPosted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post that.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 26 }}>
      <div>
        <div className="ask-card">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => submitOnShortcut(event, () => void submit())}
            placeholder="What do you want to know? Name the course, the building, the office or the year, and people can actually answer."
            maxLength={QUESTION_MAX}
            rows={4}
            aria-label="Your question"
          />
          <div className="bar">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="First name (optional)" maxLength={40} aria-label="Your name" />
            <span className="count">
              {text.length}/{QUESTION_MAX}
            </span>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={!ready}>
              {posting ? 'Posting' : 'Post question'}
            </button>
          </div>
        </div>
        <div className="ask-tips">
          <span className="tag">Anonymous unless you add a name</span>
          <span className="tag">Answered questions feed Ask</span>
          <span className="tag">
            <span className="kbd">⌘↵</span> posts
          </span>
        </div>
        {error && (
          <div className="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
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
        <div className="stack" style={{ gap: 14 }}>
          <div className="posted">
            <span className="ic">
              <IconCheck />
            </span>
            <div>
              <b>Posted</b>
              It will be shown to students who can answer it. Come back here for replies; answered questions also feed straight into Ask.
            </div>
          </div>
          {posted.similar.length > 0 && (
            <>
              <h2 className="section-title" style={{ marginTop: 6 }}>
                Already answered on the board
              </h2>
              <div className="qa-list">
                {posted.similar.map((entry) => (
                  <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
                ))}
              </div>
            </>
          )}
          {posted.related.length > 0 && (
            <>
              <h2 className="section-title" style={{ marginTop: 6 }}>
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
          <h2 className="section-title" style={{ marginTop: 0 }}>
            Your questions
          </h2>
          <div className="qa-list">
            {mine.map((entry) => (
              <QuestionThread key={entry.id} question={entry} answers={entry.answers} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function QuestionThread({ question, answers }: { question: Question; answers: Answer[] }) {
  return (
    <div className="qa">
      <div className="q">{question.text}</div>
      <div className="status">
        {answers.length === 0 ? (
          <span className="pill k-sun">
            <i /> Waiting · seen by {plural(question.views, 'student')}
          </span>
        ) : (
          <span className="pill k-ok">
            <i /> {plural(answers.length, 'answer')}
          </span>
        )}
        <span>{question.askerName ? `${question.askerName} · ` : ''}{relativeDate(question.createdAt)}</span>
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
          <div className="by">
            <span className="avatar sm">{initials(answer.helperName)}</span>
            <b>{answer.helperName}</b>
            <span>
              {answer.helperMajor}, {standingLabel(answer.helperYear)} · {relativeDate(answer.createdAt)}
            </span>
          </div>
          <div className="text">{answer.text}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Answer questions ---------- */

const MILESTONES: Record<number, { title: string; message: string }> = {
  1: { title: 'Your first answer', message: 'Someone is about to get an answer from a person instead of a search box. Thank you.' },
  10: { title: 'Ten answers', message: 'You have helped ten people. The answer engine now cites you next to the archive.' },
  25: { title: 'Twenty-five answers', message: 'A quarter of a hundred. At this point you are part of how this place works.' },
  50: { title: 'Fifty answers', message: 'Fifty people helped. That is a lot of afternoons saved.' },
  100: { title: 'One hundred answers', message: 'A hundred. There should be a plaque. Until then, confetti.' },
};

function HelpOut({ onChange }: { onChange(): void }) {
  const { profile, setProfile, celebrate, requestProfile } = useApp();
  const [card, setCard] = useState<{ question: Question | null; remaining: number; answered: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState(0);
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
        <Mark solid className="mark" />
        <h2>Help a student out</h2>
        <p>Questions get routed to the right people by major and year, and your name appears next to what you write. Tell us who you are once and the cards start coming.</p>
        <button type="button" className="btn primary lg" onClick={() => void requestProfile({ title: 'Before you answer', reason: 'Questions are routed by major and year, and your name appears next to what you write. One time only.' })}>
          Introduce yourself
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
        setSession((count) => count + 1);
        onChange();
        const milestone = MILESTONES[result.answered];
        if (milestone) celebrate({ ...milestone, action: 'Keep going' });
      } else await api.board.skip({ netId: profile.netId, questionId: card.question.id });
      await load();
      textareaRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  if (!card) {
    return (
      <div className="status-line">
        {error ? (
          <span className="alert">{error}</span>
        ) : (
          <>
            <span className="spinner" /> Finding a question for you
          </>
        )}
      </div>
    );
  }

  const question = card.question;
  const total = session + card.remaining;
  return (
    <div>
      <div className="deck-head">
        <span>
          {question ? (
            <>
              <b>{plural(card.remaining, 'question')}</b> waiting for you
            </>
          ) : (
            'Nothing waiting for you'
          )}
        </span>
        <span>
          You have answered <b>{card.answered}</b>
        </span>
      </div>
      {total > 0 && (
        <div className="progress-bar" style={{ marginBottom: 14 }} aria-hidden="true">
          <i style={{ width: `${Math.round((session / total) * 100)}%` }} />
        </div>
      )}
      {question ? (
        <div className={`deck${card.remaining <= 1 ? ' single' : ''}`}>
          <div className="flashcard" key={question.id}>
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
                {(question.majors.length > 0 || question.years.length > 0) && <span className="tag k-violet kind">for {[...question.majors, ...question.years.map(standingLabel)].join(', ')}</span>}
              </div>
            </div>
            <textarea
              ref={textareaRef}
              className="input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => submitOnShortcut(event, () => void act('answer'))}
              placeholder="A few honest sentences are plenty. Say what you did, what you would do differently, and when this was."
              rows={4}
              maxLength={1200}
              aria-label="Your answer"
            />
            {error && <div className="alert">{error}</div>}
            <div className="flashcard-actions">
              <button type="button" className="btn ghost" onClick={() => void act('skip')} disabled={busy}>
                <IconSkip /> Not for me
              </button>
              <span className="hint">
                <span className="kbd">⌘↵</span> to send
              </span>
              <button type="button" className="btn primary" onClick={() => void act('answer')} disabled={busy || text.trim().length < 2}>
                Send answer
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="caught-up">
          <span className="big" aria-hidden="true">
            🎉
          </span>
          <h3>All caught up</h3>
          <p>{session > 0 ? `${plural(session, 'answer')} today. ` : ''}New questions will show up here as students ask them. Thanks for helping.</p>
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
    <div className="page">
      <button type="button" className="btn ghost sm back" onClick={() => navigate({ name: 'questions' })}>
        <IconBack /> Questions
      </button>
      {error && <div className="alert">{error}</div>}
      {data && <QuestionThread question={data.question} answers={data.answers} />}
    </div>
  );
}
