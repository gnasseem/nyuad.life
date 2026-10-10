import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, askStream, type Announcement, type Listing, type MarketSummary, type QuestionWithAnswers } from '../api';
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
import { askerKey, loadConversations, saveConversation, setActiveConversation, toHistory, uid, type Conversation, type Message } from '../store';

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

export function AskPage({ resumeId }: Props) {
  const { health, toast, askPrefill, setAskPrefill, setBoardPrefill, chatgpt, refreshChatGPT } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => (resumeId && loadConversations().find((entry) => entry.id === resumeId)) || fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [departing, setDeparting] = useState(0);
  const [hot, setHot] = useState<Hot | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const mounted = useRef(true);

  // Leaving the page stops the answer, so it cannot finish later and pull the page back to Ask. What had come in is
  // saved first, marked as cut short, so coming back to Ask shows the conversation with "Ask again".
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!abortRef.current) return;
      saveConversation(conversationRef.current);
      abortRef.current.abort();
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    conversationRef.current = fresh();
    setConversation(conversationRef.current);
    setInput('');
    setExpanded(new Set());
  }, []);

  useEffect(() => {
    const current = conversationRef.current;
    if (resumeId) {
      // The conversation in the address is the one Ask comes back to from other pages.
      if (resumeId === current.id) return setActiveConversation(resumeId);
      const saved = loadConversations().find((entry) => entry.id === resumeId);
      if (saved) {
        // An answer still coming in for the conversation being left is kept as cut short, as when leaving the page.
        if (abortRef.current) {
          saveConversation(current);
          abortRef.current.abort();
        }
        conversationRef.current = saved;
        setConversation(saved);
        setExpanded(new Set());
            setActiveConversation(saved.id);
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
      // Saved and given an address straight away, so the question survives a reload or a trip to another page.
      saveConversation(conversationRef.current);
      setActiveConversation(current.id);
      navigate({ name: 'ask' }, { replace: true, search: `c=${current.id}`, keepScroll: true });
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
            onDone: ({ confidence }) => patchMessage(modelMessage.id, (message) => ({ confidence, content: stripConfidence(message.content) })),
          },
          controller.signal,
        );
        patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, truncated: !complete && !message.redirect ? true : undefined }));
        saveConversation({ ...conversationRef.current, updatedAt: new Date().toISOString() });
      } catch (error) {
        // Leaving the page, starting over or opening another conversation aborts too; each has dealt with this one.
        if (!mounted.current || conversationRef.current.id !== current.id) return;
        if (controller.signal.aborted) {
          patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, error: message.content ? undefined : 'Stopped' }));
        } else {
          // fetch() itself failing means the network, not the server: say so in words a student can act on.
          const offline = error instanceof TypeError;
          const code = error instanceof ApiError ? error.code : offline ? 'network' : undefined;
          const text = offline ? 'Could not reach the server. Check your connection and try again.' : error instanceof Error ? error.message : 'The request failed.';
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: text, errorCode: code });
          // The server cleared an expired ChatGPT sign-in; show the page as signed out.
          if (code === 'chatgpt_expired' || code === 'chatgpt_required') refreshChatGPT();
        }
        saveConversation(conversationRef.current);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
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

  // Sources stay folded under the answer until asked for: a citation opens the list and lights its source up.
  const jumpToSource = (messageId: string, n: number) => {
    setExpanded((current) => new Set(current).add(messageId));
    setHot({ messageId, n });
    window.setTimeout(() => {
      document.getElementById(`source-${messageId}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
    window.setTimeout(() => setHot((current) => (current?.messageId === messageId && current.n === n && !current.rect ? null : current)), 1800);
  };

  // Hovering a citation previews its source beside it.
  const hoverCitation = (messageId: string, n: number | null, rect?: DOMRect) => {
    if (n === null) return setHot(null);
    setHot({ messageId, n, rect });
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
        answersOff={Boolean(health && !(health.answers?.available ?? health.gemini.configured) && !chatgpt?.available)}
      />
    );
  }


  return (
    <div className="conv">
      <div className="conv-main">
        <div className="conv-head">
          <span className="conv-title">Ask / conversation</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              reset();
              setActiveConversation(null);
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
              <div key={message.id} data-id={message.id} className={`turn model${message.pending && !message.content ? ' pending' : ''}`}>
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
                    {message.sources?.length ? <div>Sources found for this question are below.</div> : null}
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
                  <div className={`collapse${expanded.has(message.id) || message.error ? ' open' : ''}`} inert={!expanded.has(message.id) && !message.error}>
                    <div>
                      <div className="sources">
                        {message.sources.map((source) => (
                          <SourceRow key={source.n} id={`source-${message.id}-${source.n}`} source={source} hot={hot?.messageId === message.id && hot.n === source.n} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
        <div className="composer-wrap">{composer}</div>
      </div>
      {popover}
    </div>
  );
}

/** Show the server's current step without inventing a completion percentage. */
function Route({ status }: { status: string }) {
  const stage = STAGES.findIndex((entry) => entry.match.test(status));
  return (
    <div className="ask-process" role="status" aria-live="polite">
      <div className="process-status"><span className="process-cursor" aria-hidden="true" /><span>{status}</span></div>
      <div className="process-steps" aria-hidden="true">
        {STAGES.map((entry, index) => (
          <span key={entry.label} className={stage > index ? 'done' : stage === index ? 'now' : ''}>
            <i />{entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

interface HomeData {
  notices: Announcement[] | null;
  rides: Listing[] | null;
  listings: number;
  markets: Array<{ currency: 'falcon' | 'campus'; label: string; summary: MarketSummary }>;
  answered: QuestionWithAnswers[] | null;
  open: number | null;
}

function useHomeData(): HomeData {
  const { boardProblem, setAskPrefill } = useApp();
  const [data, setData] = useState<HomeData>({ notices: null, rides: null, listings: 0, markets: [], answered: null, open: null });
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
  }, [boardProblem]);
  return data;
}

function Home({ composer, answersOff }: { composer: ReactNode; answersOff: boolean }) {
  const { boardProblem, setAskPrefill } = useApp();
  const data = useHomeData();
  const now = useNow();
  const upcoming = (data.notices ?? []).filter((entry) => entry.kind === 'event' && entry.startsAt && Date.parse(entry.startsAt) > now.getTime() - 3 * 3_600_000).slice(0, 3);
  const offline = boardProblem ? <p className="stops-note">Unavailable right now.</p> : null;

  return (
    <div className="home">
      <section className="central">
        <div className="terminal-bar"><span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span><span>nyuad.life / ask</span></div>
        <div className="central-sign">
          <h1>What do you need to know?</h1>
          <span lang="ar" dir="rtl">
            اسأل
          </span>
        </div>
        <p className="ask-intro">Find answers in official NYUAD pages, course information and student experiences.</p>
        <div className="central-ask">
          {composer}
          {answersOff && <p className="central-note">Answers are paused right now.</p>}
          <ChatGPTLine />
          <div className="ask-suggestions" aria-label="Try a question">
            {['How does course registration work?', 'Where can I find academic deadlines?', 'What are the pool hours?'].map((question) => <button type="button" key={question} onClick={() => setAskPrefill({ question, autoSend: false })}>{question}<IconArrow /></button>)}
          </div>
        </div>
      </section>

      <div className="line-cards">
        <LineCard line="notices" title="Events" ar="الفعاليات" href="/events">
          {offline ??
            (data.notices === null ? (
              <Loading />
            ) : upcoming.length === 0 ? (
              <p className="stops-note">
                Nothing coming up.{' '}
                <a href="/events" onClick={onLinkClick}>
                  Post an event
                </a>
              </p>
            ) : (
              upcoming.map((entry) => (
                <a key={entry.id} className="stn" href="/events" onClick={onLinkClick}>
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
                <a href="/questions" onClick={onLinkClick}>
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
          <a className="stn" href="/courses" onClick={onLinkClick}>
            <span className="when">Rate</span>
            <span className="what">How students rate any course</span>
          </a>
          <a className="stn" href="/plan" onClick={onLinkClick}>
            <span className="when">Plan</span>
            <span className="what">Build next term's schedule</span>
          </a>
          <a className="stn" href="/threads" onClick={onLinkClick}>
            <span className="when">Threads</span>
            <span className="what">Search the group's old posts</span>
          </a>
        </LineCard>
      </div>

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
  return `${dayName(when, now)} ${formatTime(entry.startsAt)}`;
}

function rideWhen(iso: string, now: Date): string {
  const when = new Date(iso);
  return dayName(when, now) === 'Today' ? formatTime(iso) : `${dayName(when, now)} ${formatTime(iso)}`;
}

function dayName(when: Date, now: Date): string {
  const key = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  if (key(when) === key(now)) return 'Today';
  if (key(when) === key(new Date(now.getTime() + 86_400_000))) return 'Tomorrow';
  return when.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short' });
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
