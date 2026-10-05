import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, askStream, type Announcement, type Listing, type MarketSummary, type QuestionWithAnswers, type SourceCard } from '../api';
import { ChatGPTLine, ChatGPTSignIn } from '../components/ChatGPT';
import { Flap } from '../components/Flap';
import { RedirectCard } from '../components/RedirectCard';
import { SourceRow } from '../components/SourceRow';
import { useApp } from '../context';
import { formatTime, plural, relativeDate, startsIn } from '../format';
import { IconArrow, IconCheck, IconChevron, IconCopy, IconPlus, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { useNow } from '../motion';
import { navigate, onLinkClick } from '../router';
import { askerKey, loadConversations, saveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
}

interface Hot {
  messageId: string;
  n: number;
  rect?: DOMRect;
}

const CONFIDENCE_LABEL = { high: 'Well sourced', medium: 'Partly sourced', low: 'Weakly sourced' };
/** Failures worth simply asking again: busy or spent models, a timeout, a dropped connection. */
const RETRYABLE = new Set(['busy', 'quota', 'timeout', 'model_error', 'empty_answer', 'error', 'network', 'stream_error']);
const STAGES: Array<{ label: string; match: RegExp }> = [
  { label: 'Reading', match: /^reading/i },
  { label: 'Searching', match: /^search/i },
  { label: 'Ranking sources', match: /^rank/i },
  { label: 'Writing', match: /^writ/i },
];
const KIND_COLOR: Record<SourceCard['kind'], string> = { archive: 'var(--cobalt)', official: 'var(--cobalt)', schedule: 'var(--cobalt)', board: 'var(--green)', announcement: 'var(--amber)' };

export function AskPage({ resumeId }: Props) {
  const { home, health, toast, askPrefill, setAskPrefill, setBoardPrefill, chatgpt, refreshChatGPT } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => (resumeId && loadConversations().find((entry) => entry.id === resumeId)) || fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [departing, setDeparting] = useState(0);
  const [hot, setHot] = useState<Hot | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [railId, setRailId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const mounted = useRef(true);

  // Leaving the page stops the answer, so it cannot finish later and pull the page back to Ask.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    conversationRef.current = fresh();
    setConversation(conversationRef.current);
    setInput('');
    setExpanded(new Set());
    setRailId(null);
  }, []);

  useEffect(() => {
    const current = conversationRef.current;
    if (resumeId) {
      if (resumeId === current.id) return;
      const saved = loadConversations().find((entry) => entry.id === resumeId);
      if (saved) {
        conversationRef.current = saved;
        setConversation(saved);
        setRailId(null);
      }
    } else if (current.messages.length > 0) {
      reset();
    }
  }, [resumeId, reset]);

  // Every change goes through the ref first, so a save right after a patch sees the patched conversation rather than
  // whatever React has rendered so far.
  const update = useCallback((updater: (current: Conversation) => Conversation) => {
    const next = updater(conversationRef.current);
    conversationRef.current = next;
    setConversation(next);
  }, []);

  const patchMessage = useCallback(
    (id: string, patch: Partial<Message> | ((message: Message) => Partial<Message>)) => {
      update((current) => ({
        ...current,
        messages: current.messages.map((message) => (message.id === id ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)),
      }));
    },
    [update],
  );

  const send = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || running) return;
      const current = conversationRef.current;
      const history = toHistory(current.messages);
      const userMessage: Message = { id: uid(), role: 'user', content: question };
      const modelMessage: Message = { id: uid(), role: 'model', content: '', pending: true, status: 'Reading the question' };
      update((c) => ({ ...c, title: c.title || question.slice(0, 80), updatedAt: new Date().toISOString(), messages: [...c.messages, userMessage, modelMessage] }));
      setInput('');
      setRunning(true);
      setDeparting((n) => n + 1);
      setRailId(modelMessage.id);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { complete } = await askStream(
          question,
          history,
          {
            onStatus: (status) => patchMessage(modelMessage.id, { status }),
            onRedirect: (redirect) => patchMessage(modelMessage.id, { redirect, status: undefined }),
            onSources: (sources) => patchMessage(modelMessage.id, { sources }),
            onDelta: (text) => patchMessage(modelMessage.id, (message) => ({ content: message.content + text, status: undefined })),
            onFollowups: (followups) => patchMessage(modelMessage.id, { followups }),
            onDone: ({ confidence }) => patchMessage(modelMessage.id, (message) => ({ confidence, content: stripConfidence(message.content) })),
          },
          controller.signal,
        );
        patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, truncated: !complete && !message.redirect ? true : undefined }));
        const done = { ...conversationRef.current, updatedAt: new Date().toISOString() };
        saveConversation(done);
        if (mounted.current) navigate({ name: 'ask' }, { replace: true, search: `c=${done.id}`, keepScroll: true });
      } catch (error) {
        if (controller.signal.aborted) {
          patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, error: message.content ? undefined : 'Stopped' }));
          if (conversationRef.current.messages.some((m) => m.role === 'model' && m.content && !m.error)) saveConversation(conversationRef.current);
        } else {
          // fetch() itself failing means the network, not the server: say so in words a student can act on.
          const offline = error instanceof TypeError;
          const code = error instanceof ApiError ? error.code : offline ? 'network' : undefined;
          const text = offline ? 'Could not reach the server. Check your connection and try again.' : error instanceof Error ? error.message : 'The request failed.';
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: text, errorCode: code });
          // The server cleared an expired ChatGPT sign-in; show the page as signed out.
          if (code === 'chatgpt_expired' || code === 'chatgpt_required') refreshChatGPT();
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running, update, patchMessage, refreshChatGPT],
  );

  useEffect(() => {
    if (!askPrefill) return;
    setAskPrefill(null);
    if (askPrefill.autoSend) void send(askPrefill.question);
    else {
      setInput(askPrefill.question);
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askPrefill?.token]);

  useEffect(() => {
    if (running) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.messages.length, running]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(220, element.scrollHeight)}px`;
  }, [input]);

  const empty = conversation.messages.length === 0;
  useEffect(() => {
    document.documentElement.toggleAttribute('data-conv', !empty);
    return () => document.documentElement.removeAttribute('data-conv');
  }, [empty]);

  // The source rail follows the answer you are reading: the model turn nearest the middle of the screen.
  useEffect(() => {
    if (empty) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const turns = [...document.querySelectorAll<HTMLElement>('.turn.model[data-id]')];
        const middle = window.innerHeight * 0.45;
        let best: HTMLElement | undefined;
        for (const turn of turns) if (turn.getBoundingClientRect().top < middle) best = turn;
        const id = (best ?? turns[0])?.dataset.id;
        if (id) setRailId((current) => (current === id ? current : id));
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, [empty]);

  const stop = () => abortRef.current?.abort();

  /** Asks a failed question again in place of the failed turn, rather than below it. */
  const retry = (modelId: string) => {
    const messages = conversationRef.current.messages;
    const index = messages.findIndex((message) => message.id === modelId);
    const question = questionBefore(messages, modelId);
    if (index < 1 || !question) return;
    update((current) => ({ ...current, messages: current.messages.filter((_, i) => i !== index && i !== index - 1) }));
    void send(question);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text.replace(/\[(\d+)\]/g, ''));
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      toast('Could not copy');
    }
  };

  const toggleSources = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const wide = () => window.matchMedia('(min-width: 1241px)').matches;

  const jumpToSource = (messageId: string, n: number) => {
    setRailId(messageId);
    if (!wide()) setExpanded((current) => new Set(current).add(messageId));
    setHot({ messageId, n });
    window.setTimeout(() => {
      document.getElementById(`${wide() ? 'rail' : 'source'}-${messageId}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: wide() ? 'nearest' : 'center' });
    }, 30);
    window.setTimeout(() => setHot((current) => (current?.messageId === messageId && current.n === n && !current.rect ? null : current)), 1800);
  };

  const hoverCitation = (messageId: string, n: number | null, rect?: DOMRect) => {
    if (n === null) return setHot(null);
    setRailId(messageId);
    // With the rail on screen the source lights up there; without it, a preview floats by the pill.
    setHot({ messageId, n, rect: wide() ? undefined : rect });
    if (wide()) document.getElementById(`rail-${messageId}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const askStudents = (question: string) => {
    setBoardPrefill(question);
    navigate({ name: 'questions' });
  };

  const popover = useMemo(() => {
    if (!hot?.rect) return null;
    const message = conversation.messages.find((entry) => entry.id === hot.messageId);
    const source = message?.sources?.find((entry) => entry.n === hot.n);
    if (!source) return null;
    const width = Math.min(380, window.innerWidth - 32);
    const left = Math.max(16, Math.min(hot.rect.left, window.innerWidth - width - 16));
    const below = hot.rect.bottom + 8;
    const style = below + 180 < window.innerHeight ? { top: below, left } : { bottom: window.innerHeight - hot.rect.top + 8, left };
    return createPortal(
      <div className="cite-pop" style={style}>
        <SourceRow source={source} hot />
      </div>,
      document.body,
    );
  }, [hot, conversation.messages]);

  const composer = (
    <div className="composer">
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKey}
        placeholder={empty ? 'Ask about a course, a professor, housing, a visa…' : 'Ask a follow-up'}
        maxLength={600}
        aria-label="Your question"
        autoFocus={window.matchMedia('(min-width: 900px)').matches}
      />
      {running ? (
        <button type="button" className="send stop" onClick={stop} aria-label="Stop">
          <IconStop />
        </button>
      ) : (
        <button key={departing} type="button" className={`send${departing ? ' depart' : ''}`} onClick={() => void send(input)} disabled={!input.trim()} aria-label="Ask">
          <IconArrow />
        </button>
      )}
    </div>
  );

  if (empty) {
    return (
      <Home
        composer={composer}
        suggestions={home?.suggestions ?? []}
        onSuggestion={(question) => void send(question)}
        answersOff={Boolean(health && !(health.answers?.available ?? health.gemini.configured) && !chatgpt?.available)}
      />
    );
  }

  const railMessage = conversation.messages.find((message) => message.id === railId && message.role === 'model') ?? [...conversation.messages].reverse().find((message) => message.role === 'model');
  const railSources = railMessage?.sources ?? [];

  return (
    <div className="conv">
      <div className="conv-main">
        <div className="conv-head">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              reset();
              navigate({ name: 'ask' });
            }}
          >
            <IconPlus /> New question
          </button>
        </div>
        <div className="thread">
          {conversation.messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="turn user">
                {message.content}
              </div>
            ) : (
              <div key={message.id} data-id={message.id} className={`turn model${message.pending && !message.content ? ' pending' : ''}`} style={{ '--route': routeGradient(message.sources) } as React.CSSProperties}>
                {message.status && <Route status={message.status} />}
                {message.redirect && <RedirectCard redirect={message.redirect} />}
                {message.content && (
                  <div className="answer">
                    <Markdown
                      text={message.content}
                      hot={hot?.messageId === message.id ? hot.n : null}
                      citeKind={(n) => message.sources?.find((source) => source.n === n)?.kind}
                      onCitation={(n) => jumpToSource(message.id, n)}
                      onCitationHover={(n, rect) => hoverCitation(message.id, n, rect)}
                    />
                    {message.pending && <span className="cursor" />}
                  </div>
                )}
                {message.error && (
                  <div className="alert error" role="alert">
                    {message.error}
                    {(message.errorCode === 'chatgpt_required' || message.errorCode === 'chatgpt_expired' || message.errorCode === 'chatgpt_plan') && (
                      <div style={{ marginTop: 10 }}>
                        <ChatGPTSignIn className="btn sm primary" />
                      </div>
                    )}
                    {message.error !== 'Stopped' && (!message.errorCode || RETRYABLE.has(message.errorCode)) && (
                      <div className="alert-actions">
                        <button type="button" className="link-btn" onClick={() => retry(message.id)} disabled={running}>
                          Try again
                        </button>
                        <a className="link-btn" href={`/threads?q=${encodeURIComponent(questionBefore(conversation.messages, message.id))}`} onClick={onLinkClick}>
                          Search the group's threads instead
                        </a>
                      </div>
                    )}
                  </div>
                )}
                {message.truncated && !message.pending && (
                  <div className="alert cut">
                    This answer was cut short.{' '}
                    <button type="button" className="link-btn" onClick={() => void send(questionBefore(conversation.messages, message.id))} disabled={running}>
                      Ask again
                    </button>
                  </div>
                )}
                {!message.pending && message.content && (
                  <div className="answer-foot">
                    {message.confidence && (
                      <span className="confidence-line">
                        <span className={`pill confidence ${message.confidence.level}`}>
                          <span className="dot" /> {CONFIDENCE_LABEL[message.confidence.level]}
                        </span>
                        {message.confidence.reason && <span className="confidence-reason">{message.confidence.reason}</span>}
                      </span>
                    )}
                    {message.sources && message.sources.length > 0 && (
                      <button type="button" className={`foot-btn sources-toggle${expanded.has(message.id) ? ' open' : ''}`} onClick={() => toggleSources(message.id)} aria-expanded={expanded.has(message.id)}>
                        {plural(message.sources.length, 'source')} <IconChevron className="chev" />
                      </button>
                    )}
                    <button type="button" className="foot-btn" onClick={() => void copy(message.id, message.content)}>
                      {copied === message.id ? (
                        <>
                          <IconCheck className="pop-in" /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy /> Copy
                        </>
                      )}
                    </button>
                    {(!message.confidence || message.confidence.level !== 'high') && (
                      <button type="button" className="foot-btn" onClick={() => askStudents(questionBefore(conversation.messages, message.id))}>
                        Ask students <IconArrow />
                      </button>
                    )}
                  </div>
                )}
                {message.sources && message.sources.length > 0 && (
                  <div className={`collapse${expanded.has(message.id) ? ' open' : ''}`} inert={!expanded.has(message.id)}>
                    <div>
                      <div className="sources">
                        {message.sources.map((source) => (
                          <SourceRow key={source.n} id={`source-${message.id}-${source.n}`} source={source} hot={hot?.messageId === message.id && hot.n === source.n} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {!message.pending && !message.error && message.followups && message.followups.length > 0 && (
                  <div className="followups">
                    {message.followups.map((question) => (
                      <button key={question} type="button" className="followup" onClick={() => void send(question)} disabled={running}>
                        {question}
                        <IconArrow />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
        <div className="composer-wrap">{composer}</div>
      </div>
      <aside className="conv-rail" aria-label="Sources">
        <h2>
          Sources
        </h2>
        {railSources.length > 0 ? (
          <div className="rail-sources">
            {railSources.map((source) => (
              <SourceRow
                key={`${railMessage!.id}-${source.n}`}
                id={`rail-${railMessage!.id}-${source.n}`}
                source={source}
                hot={hot?.messageId === railMessage!.id && hot.n === source.n}
                onHover={(n) => setHot(n === null ? null : { messageId: railMessage!.id, n })}
              />
            ))}
          </div>
        ) : (
          <p className="rail-empty">{railMessage?.pending ? 'Searching…' : 'No sources.'}</p>
        )}
      </aside>
      {popover}
    </div>
  );
}

/** The four stages the server reports, as stops on a short line that fills as the answer is put together. */
function Route({ status }: { status: string }) {
  const stage = STAGES.findIndex((entry) => entry.match.test(status));
  return (
    <div className="route" role="status" aria-label={status}>
      {STAGES.map((entry, index) => (
        <span key={entry.label} style={{ display: 'contents' }}>
          {index > 0 && <span className={`route-seg${stage >= index ? ' done' : ''}`} />}
          <span className={`route-stop${stage > index ? ' done' : stage === index ? ' now' : ''}`}>
            <i /> {entry.label}
          </span>
        </span>
      ))}
      {stage < 0 && <span className="route-note">{status}</span>}
    </div>
  );
}

/** The line beside an answer, coloured by the lines its sources came from, in the order they are numbered. */
function routeGradient(sources: SourceCard[] | undefined): string | undefined {
  if (!sources || sources.length === 0) return undefined;
  const step = 100 / sources.length;
  return `linear-gradient(${sources.map((source, index) => `${KIND_COLOR[source.kind]} ${index * step}% ${(index + 1) * step}%`).join(', ')})`;
}

interface HomeData {
  notices: Announcement[] | null;
  rides: Listing[] | null;
  listings: number;
  markets: Array<{ currency: 'falcon' | 'campus'; label: string; summary: MarketSummary }>;
  answered: QuestionWithAnswers[] | null;
  open: number | null;
  courses: { term: string; open: number; total: number } | null;
}

function useHomeData(): HomeData {
  const { boardProblem } = useApp();
  const [data, setData] = useState<HomeData>({ notices: null, rides: null, listings: 0, markets: [], answered: null, open: null, courses: null });
  useEffect(() => {
    const set = (patch: Partial<HomeData>) => setData((current) => ({ ...current, ...patch }));
    if (!boardProblem) {
      api.board
        .announcements()
        .then((result) => set({ notices: result.announcements }))
        .catch(() => set({ notices: [] }));
      api.board
        .listings(askerKey())
        .then((result) => {
          const now = Date.now();
          set({
            rides: result.listings.filter((listing) => listing.kind === 'ride' && listing.happensAt && Date.parse(listing.happensAt) > now - 30 * 60_000).sort((a, b) => a.happensAt!.localeCompare(b.happensAt!)),
            listings: result.listings.filter((listing) => listing.kind !== 'ride').length,
          });
        })
        .catch(() => set({ rides: [] }));
      api.board
        .offers(askerKey())
        .then((result) => {
          const markets = result.markets ?? { falcon: result.market, campus: undefined };
          set({
            markets: [
              { currency: 'falcon' as const, label: 'Falcons', summary: markets.falcon },
              { currency: 'campus' as const, label: 'Campus Dh', summary: markets.campus! },
            ].filter((entry) => entry.summary && entry.summary.open > 0),
          });
        })
        .catch(() => set({ markets: [] }));
      api.board
        .recent()
        .then((result) => set({ answered: result.questions }))
        .catch(() => set({ answered: [] }));
      api.board
        .stats()
        .then((result) => set({ open: result.open }))
        .catch(() => set({ open: null }));
    }
    api.courses
      .terms()
      .then(({ current }) => api.courses.list(current))
      .then((result) => set({ courses: { term: result.term, open: result.courses.filter((course) => course.sections.some((section) => section.status === 'open')).length, total: result.courses.length } }))
      .catch(() => set({ courses: { term: '', open: 0, total: 0 } }));
  }, [boardProblem]);
  return data;
}

function Home({ composer, suggestions, onSuggestion, answersOff }: { composer: ReactNode; suggestions: Array<{ topic: string; question: string }>; onSuggestion(question: string): void; answersOff: boolean }) {
  const { boardProblem, health } = useApp();
  const threads = health?.archive?.posts ? `${(Math.floor(health.archive.posts / 500) * 500).toLocaleString('en-US')}+` : 'thousands of';
  const data = useHomeData();
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useNow();
  const upcoming = (data.notices ?? []).filter((entry) => !entry.startsAt || Date.parse(entry.startsAt) > now.getTime() - 3 * 3_600_000).slice(0, 3);
  const offline = boardProblem ? <p className="stops-note">Unavailable right now.</p> : null;

  return (
    <div className="home" ref={rootRef}>
      <section className="central">
        <div className="central-sign">
          <h1>Central</h1>
          <span lang="ar" dir="rtl">
            المركز
          </span>
        </div>
        <p className="central-lede">
          Ask anything about NYUAD. Answers come from <b>{threads} Room of Requirement threads</b>, official pages and the class schedule, with sources.
        </p>
        <div className="central-ask">
          {composer}
          {answersOff && <p className="central-note">Answers are paused right now.</p>}
          <ChatGPTLine />
        </div>
        {suggestions.length > 0 && (
          <div className="journeys">
            {suggestions.slice(0, 3).map((suggestion) => (
              <button key={suggestion.question} type="button" className="journey" onClick={() => onSuggestion(suggestion.question)}>
                {suggestion.question}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="line-cards">
        <LineCard line="notices" title="Notices" ar="الإعلانات" href="/notices">
          {offline ??
            (data.notices === null ? (
              <Loading />
            ) : upcoming.length === 0 ? (
              <p className="stops-note">
                Nothing coming up.{' '}
                <a href="/notices" onClick={onLinkClick}>
                  Post an event or deadline
                </a>
              </p>
            ) : (
              upcoming.map((entry) => (
                <a key={entry.id} className="stn" href="/notices" onClick={onLinkClick}>
                  <span className="when">{noticeWhen(entry, now)}</span>
                  <span className="what">{entry.title}</span>
                  {entry.location && <span className="where">{entry.location}</span>}
                </a>
              ))
            ))}
        </LineCard>
        <LineCard line="market" title="Market" ar="السوق" href="/market/rides">
          {offline ??
            (data.rides === null ? (
              <Loading />
            ) : (
              <>
                {data.rides.length === 0 ? (
                  <p className="stops-note">
                    {data.listings ? `${plural(data.listings, 'listing')} for sale or wanted. ` : 'No rides yet. '}
                    <a href={data.listings ? '/market' : '/market/rides'} onClick={onLinkClick}>
                      {data.listings ? 'Browse' : 'Share a ride or sell something'}
                    </a>
                  </p>
                ) : (
                  data.rides.slice(0, 3).map((ride) => {
                    const soon = startsIn(new Date(ride.happensAt!), now, 60);
                    return (
                      <a key={ride.id} className="stn" href="/market/rides" onClick={onLinkClick}>
                        <span className="when">{soon?.live ? 'Leaving now' : rideWhen(ride.happensAt!, now)}</span>
                        <span className="what">To {ride.destination}</span>
                      </a>
                    );
                  })
                )}
                {data.markets.map(({ currency, label, summary }) => (
                  <a key={currency} className="rate-board" href={currency === 'falcon' ? '/market/falcons' : '/market/campus'} onClick={onLinkClick} title={`${label}: lowest sell and highest buy, AED each`}>
                    <span>{label}</span>
                    <b className="sell">
                      <Flap text={summary.bestAsk === null ? '–' : summary.bestAsk.toFixed(2)} />
                    </b>
                    <b className="buy">
                      <Flap text={summary.bestBid === null ? '–' : summary.bestBid.toFixed(2)} />
                    </b>
                  </a>
                ))}
              </>
            ))}
        </LineCard>
        <LineCard line="questions" title="Questions" ar="الأسئلة" href="/questions">
          {offline ??
            (data.answered === null ? (
              <Loading />
            ) : data.answered.length === 0 ? (
              <p className="stops-note">
                {data.open ? `${plural(data.open, 'question')} waiting for an answer. ` : 'No answered questions yet. '}
                <a href={data.open ? '/questions?tab=help' : '/questions'} onClick={onLinkClick}>
                  {data.open ? 'Help answer' : 'Ask other students'}
                </a>
              </p>
            ) : (
              data.answered.slice(0, 3).map((question) => (
                <a key={question.id} className="stn" href={`/questions/${question.id}`} onClick={onLinkClick}>
                  <span className="when">{question.answers[0] ? `${question.answers[0].helperName.split(' ')[0]} answered` : relativeDate(question.createdAt)}</span>
                  <span className="what">{question.text}</span>
                </a>
              ))
            ))}
        </LineCard>
        <LineCard line="guide" title="Courses" ar="المساقات" href="/courses">
          {data.courses === null ? (
            <Loading />
          ) : data.courses.total === 0 ? (
            <p className="stops-note">Search every course, section and professor.</p>
          ) : (
            <>
              <a className="stn" href="/courses" onClick={onLinkClick}>
                <span className="when">{data.courses.term}</span>
                <span className="what">{plural(data.courses.total, 'course')}, {data.courses.open} with open seats</span>
              </a>
              <a className="stn" href="/courses?core=1" onClick={onLinkClick}>
                <span className="when">Core</span>
                <span className="what">Core Curriculum courses this term</span>
              </a>
              <a className="stn" href="/threads" onClick={onLinkClick}>
                <span className="when">Threads</span>
                <span className="what">Search the group's old posts</span>
              </a>
            </>
          )}
        </LineCard>
      </div>

      <HomeLines root={rootRef} deps={[data, suggestions.length, answersOff]} />
    </div>
  );
}

function Loading() {
  return (
    <div className="stops-note">
      <span className="spinner" />
    </div>
  );
}

function noticeWhen(entry: Announcement, now: Date): string {
  if (!entry.startsAt) return 'Open';
  const when = new Date(entry.startsAt);
  const soon = startsIn(when, now);
  if (soon?.live) return 'Now';
  const allDay = when.getHours() === 0 && when.getMinutes() === 0;
  return allDay ? dayName(when, now) : `${dayName(when, now)} ${formatTime(entry.startsAt)}`;
}

function rideWhen(iso: string, now: Date): string {
  const when = new Date(iso);
  return when.toDateString() === now.toDateString() ? formatTime(iso) : `${dayName(when, now)} ${formatTime(iso)}`;
}

function dayName(when: Date, now: Date): string {
  if (when.toDateString() === now.toDateString()) return 'Today';
  if (when.toDateString() === new Date(now.getTime() + 86_400_000).toDateString()) return 'Tomorrow';
  return when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** One line's card under Central: its ring, where the line from Central comes in, and the next stops on it. */
function LineCard({ line, title, ar, href, children }: { line: string; title: string; ar: string; href: string; children: ReactNode }) {
  return (
    <section className="line-card" data-line={line}>
      <a className="line-card-head" href={href} onClick={onLinkClick}>
        <span className="line-ring" data-ring={line} />
        <h2>{title}</h2>
        <span className="ar" lang="ar" dir="rtl">
          {ar}
        </span>
        <IconArrow />
      </a>
      <div className="stations in-plate">{children}</div>
    </section>
  );
}

const LINE_ORDER = ['notices', 'market', 'questions', 'guide'];

/**
 * The four lines leaving Central, drawn as one bundle: out of the right end of the ask box, down the right of the
 * board, back along its foot, and each one peeling off into its card. The line for the rightmost card rides on the
 * outside of every bend, so no two lines ever cross. Measured from the page; only drawn while the cards sit in a row.
 */
function HomeLines({ root, deps }: { root: React.RefObject<HTMLDivElement | null>; deps: unknown[] }) {
  const [paths, setPaths] = useState<Array<{ line: string; d: string }>>([]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      if (!window.matchMedia('(min-width: 1100px)').matches) return setPaths([]);
      const box = element.getBoundingClientRect();
      const rect = (selector: string) => element.querySelector(selector)?.getBoundingClientRect();
      const board = rect('.central');
      const composer = rect('.central .composer');
      if (!board || !composer) return;
      const gap = 11;
      const big = 30;
      const hubY = composer.top + composer.height / 2 - box.top;
      const hubX = composer.right - box.left;
      const downX = board.right - box.left - 64;
      const footY = board.bottom - box.top - 44;
      const next: Array<{ line: string; d: string }> = [];
      LINE_ORDER.forEach((line, i) => {
        const ring = rect(`[data-ring="${line}"]`);
        if (!ring) return;
        const offset = (i - 1.5) * gap;
        const r = big + offset;
        const y0 = hubY - offset;
        const x1 = downX + offset;
        const y2 = footY + offset;
        const rx = ring.left + ring.width / 2 - box.left;
        const ry = ring.top + ring.height / 2 - box.top;
        const turn = 18;
        const d = [
          `M ${hubX} ${y0}`,
          `H ${downX - big}`,
          `A ${r} ${r} 0 0 1 ${x1} ${hubY + big}`,
          `V ${footY - big}`,
          `A ${r} ${r} 0 0 1 ${downX - big} ${y2}`,
          `H ${rx + turn}`,
          `A ${turn} ${turn} 0 0 0 ${rx} ${y2 + turn}`,
          `V ${ry}`,
        ].join(' ');
        next.push({ line, d });
      });
      setPaths(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll('.central, .line-card').forEach((node) => observer.observe(node));
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (paths.length === 0) return null;
  return (
    <svg className="home-lines" aria-hidden="true">
      {paths.map((path, index) => (
        <path key={path.line} className="hl draw" data-line={path.line} d={path.d} pathLength={1} style={{ animationDelay: `${0.2 + index * 0.12}s` }} />
      ))}
      {paths.map((path, index) => (
        <path key={`t-${path.line}`} className="hl-train" d={path.d} pathLength={1} style={{ '--dur': `${7 + index * 1.7}s`, '--delay': `${1.4 + index * 1.1}s` } as React.CSSProperties} />
      ))}
    </svg>
  );
}

function fresh(): Conversation {
  const now = new Date().toISOString();
  return { id: uid(), title: '', createdAt: now, updatedAt: now, messages: [] };
}

function questionBefore(messages: Message[], modelId: string): string {
  const index = messages.findIndex((message) => message.id === modelId);
  for (let i = index - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messages[i]!.content;
  return '';
}

/** The server parses the confidence line off non-streamed answers; streamed text still carries it. */
function stripConfidence(text: string): string {
  return text.replace(/\n?\s*\**\s*confidence\s*:\s*\**\s*(?:high|medium|low)\**\s*(?:[–—:-]\s*)?[^\n]*$/i, '').trimEnd();
}
