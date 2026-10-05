import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, askStream, type Announcement, type Listing, type MarketSummary, type QuestionWithAnswers } from '../api';
import { ChatGPTLine, ChatGPTSignIn } from '../components/ChatGPT';
import { RedirectCard } from '../components/RedirectCard';
import { SourcePreview, SourceRow } from '../components/SourceRow';
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
  /** Where the citation is on screen; with it, the source is previewed beside the citation. */
  rect?: DOMRect;
  /** Opened by a tap rather than a hover: the preview stays until the next tap, and its links work. */
  pinned?: boolean;
}

const CONFIDENCE_LABEL = { high: 'Well sourced', medium: 'Partly sourced', low: 'Weakly sourced' };
/** Failures worth simply asking again: busy or spent models, a timeout, a dropped connection. */
const RETRYABLE = new Set(['busy', 'quota', 'timeout', 'model_error', 'empty_answer', 'error', 'network', 'stream_error']);

export function AskPage({ resumeId }: Props) {
  const { home, health, toast, askPrefill, setAskPrefill, setBoardPrefill, chatgpt, refreshChatGPT } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => (resumeId && loadConversations().find((entry) => entry.id === resumeId)) || fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
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
    setHot(null);
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
      setHot(null);
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
            onFollowups: (followups) => patchMessage(modelMessage.id, { followups }),
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

  // A preview opened by a tap closes on the next tap elsewhere, on scroll, or with Escape.
  const pinned = Boolean(hot?.pinned);
  useEffect(() => {
    if (!pinned) return;
    const close = () => setHot(null);
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.cite-pop, .cite')) close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close);
    };
  }, [pinned]);

  const stop = () => abortRef.current?.abort();

  const startOver = () => {
    reset();
    setActiveConversation(null);
    navigate({ name: 'ask' });
  };

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

  /** Opens the answer's source list and brings the source into view, lit for a moment. */
  const jumpToSource = (messageId: string, n: number) => {
    setExpanded((current) => new Set(current).add(messageId));
    setHot({ messageId, n });
    window.setTimeout(() => document.getElementById(`source-${messageId}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30);
    window.setTimeout(() => setHot((current) => (current?.messageId === messageId && current.n === n && !current.rect ? null : current)), 1800);
  };

  // With a mouse, hovering a citation previews its source and clicking goes to it in the list. A touch screen has no
  // hover, so a tap previews the source instead, and the preview links on to the list.
  const canHover = () => window.matchMedia('(hover: hover)').matches;

  const hoverCitation = (messageId: string, n: number | null, rect?: DOMRect) => {
    if (!canHover()) return;
    setHot(n === null ? null : { messageId, n, rect });
  };

  const clickCitation = (messageId: string, n: number, rect: DOMRect) => {
    if (canHover()) return jumpToSource(messageId, n);
    setHot((current) => (current?.pinned && current.messageId === messageId && current.n === n ? null : { messageId, n, rect, pinned: true }));
  };

  const askStudents = (question: string) => {
    setBoardPrefill(question);
    navigate({ name: 'questions' });
  };

  const preview = (() => {
    if (!hot?.rect) return null;
    const message = conversation.messages.find((entry) => entry.id === hot.messageId);
    const source = message?.sources?.find((entry) => entry.n === hot.n);
    if (!source) return null;
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(16, Math.min(hot.rect.left - 12, window.innerWidth - width - 16));
    const below = hot.rect.bottom + 6;
    const style = below + 200 < window.innerHeight ? { top: below, left, width } : { bottom: window.innerHeight - hot.rect.top + 6, left, width };
    const { messageId, n } = hot;
    return createPortal(
      <div className={`cite-pop${hot.pinned ? ' pinned' : ''}`} style={style} role={hot.pinned ? 'dialog' : 'tooltip'} aria-label={`Source ${n}`}>
        <SourcePreview source={source} onLocate={hot.pinned ? () => jumpToSource(messageId, n) : undefined} />
      </div>,
      document.body,
    );
  })();

  const empty = conversation.messages.length === 0;

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
        <button type="button" className="send" onClick={() => void send(input)} disabled={!input.trim()} aria-label="Ask">
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

  return (
    <div className="conv">
      <div className="conv-head">
        <button type="button" className="btn ghost sm" onClick={startOver}>
          <IconPlus /> New question
        </button>
      </div>
      <div className="thread">
        {conversation.messages.map((message) =>
          message.role === 'user' ? (
            <h2 key={message.id} className="turn user">
              {message.content}
            </h2>
          ) : (
            <div key={message.id} className="turn model">
              {message.status && <Status text={message.status} />}
              {message.redirect && <RedirectCard redirect={message.redirect} />}
              {message.content && (
                <div className="answer">
                  <Markdown
                    text={message.content}
                    hot={hot?.messageId === message.id ? hot.n : null}
                    onCitation={(n, rect) => clickCitation(message.id, n, rect)}
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
                      <span className={`confidence ${message.confidence.level}`}>{CONFIDENCE_LABEL[message.confidence.level]}</span>
                      {message.confidence.reason && <span className="confidence-reason">{message.confidence.reason}</span>}
                    </span>
                  )}
                  <span className="foot-actions">
                    {message.sources && message.sources.length > 0 && (
                      <button type="button" className={`foot-btn${expanded.has(message.id) ? ' open' : ''}`} onClick={() => toggleSources(message.id)} aria-expanded={expanded.has(message.id)} aria-controls={`sources-${message.id}`}>
                        Sources ({message.sources.length}) <IconChevron className="chev" />
                      </button>
                    )}
                    <button type="button" className="foot-btn" onClick={() => void copy(message.id, message.content)}>
                      {copied === message.id ? <IconCheck /> : <IconCopy />} {copied === message.id ? 'Copied' : 'Copy'}
                    </button>
                    {(!message.confidence || message.confidence.level !== 'high') && (
                      <button type="button" className="foot-btn" onClick={() => askStudents(questionBefore(conversation.messages, message.id))}>
                        Ask students
                      </button>
                    )}
                  </span>
                </div>
              )}
              {message.sources && message.sources.length > 0 && expanded.has(message.id) && (
                <div className="sources" id={`sources-${message.id}`}>
                  {message.sources.map((source) => (
                    <SourceRow key={source.n} id={`source-${message.id}-${source.n}`} source={source} hot={hot?.messageId === message.id && hot.n === source.n} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />
                  ))}
                </div>
              )}
              {!message.pending && !message.error && message.followups && message.followups.length > 0 && (
                <div className="related">
                  <h3>Related</h3>
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
      {preview}
    </div>
  );
}

/** What the server is doing while the answer is put together, as one quiet line. */
function Status({ text }: { text: string }) {
  return (
    <div className="status-line" role="status">
      <span className="pulse" aria-hidden="true" />
      {/[.…!?]$/.test(text) ? text : `${text}…`}
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
              { currency: 'campus' as const, label: 'Campus Dirhams', summary: markets.campus! },
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

/** Ask with nothing asked yet: the question box, a few questions to start from, and what is new around the site. */
function Home({ composer, suggestions, onSuggestion, answersOff }: { composer: ReactNode; suggestions: Array<{ topic: string; question: string }>; onSuggestion(question: string): void; answersOff: boolean }) {
  const { boardProblem } = useApp();
  const data = useHomeData();
  const now = useNow();
  const upcoming = (data.notices ?? []).filter((entry) => !entry.startsAt || Date.parse(entry.startsAt) > now.getTime() - 3 * 3_600_000).slice(0, 3);
  const offline = boardProblem ? <p className="home-empty">Unavailable right now.</p> : null;

  return (
    <div className="home">
      <section className="home-hero">
        <h1>What do you want to know?</h1>
        {composer}
        {answersOff && <p className="home-note">Answers are paused right now.</p>}
        <ChatGPTLine />
        {suggestions.length > 0 && (
          <div className="suggestions" role="group" aria-label="Suggested questions">
            {suggestions.slice(0, 4).map((suggestion) => (
              <button key={suggestion.question} type="button" className="suggestion" onClick={() => onSuggestion(suggestion.question)}>
                <span>{suggestion.question}</span>
                <IconArrow />
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="home-grid">
        <OverviewCard title="Notices" href="/notices">
          {offline ??
            (data.notices === null ? (
              <Loading />
            ) : upcoming.length === 0 ? (
              <p className="home-empty">
                Nothing coming up.{' '}
                <a className="link" href="/notices" onClick={onLinkClick}>
                  Post an event or deadline
                </a>
              </p>
            ) : (
              upcoming.map((entry) => <OverviewRow key={entry.id} href="/notices" title={entry.title} meta={[noticeWhen(entry, now), entry.location].filter(Boolean).join(' · ')} />)
            ))}
        </OverviewCard>
        <OverviewCard title="Market" href="/market">
          {offline ??
            (data.rides === null ? (
              <Loading />
            ) : (
              <>
                {data.rides.length === 0 ? (
                  <p className="home-empty">
                    {data.listings ? `${plural(data.listings, 'listing')} for sale or wanted. ` : 'No rides yet. '}
                    <a className="link" href={data.listings ? '/market' : '/market/rides'} onClick={onLinkClick}>
                      {data.listings ? 'Browse' : 'Share a ride or sell something'}
                    </a>
                  </p>
                ) : (
                  data.rides.slice(0, 3).map((ride) => {
                    const soon = startsIn(new Date(ride.happensAt!), now, 60);
                    return <OverviewRow key={ride.id} href="/market/rides" title={`Ride to ${ride.destination}`} meta={soon?.live ? 'Leaving now' : rideWhen(ride.happensAt!, now)} />;
                  })
                )}
                {data.markets.map(({ currency, label, summary }) => (
                  <OverviewRow
                    key={currency}
                    href={currency === 'falcon' ? '/market/falcons' : '/market/campus'}
                    title={label}
                    meta={`Sell from ${summary.bestAsk === null ? '–' : summary.bestAsk.toFixed(2)} · buy up to ${summary.bestBid === null ? '–' : summary.bestBid.toFixed(2)} AED`}
                  />
                ))}
              </>
            ))}
        </OverviewCard>
        <OverviewCard title="Questions" href="/questions">
          {offline ??
            (data.answered === null ? (
              <Loading />
            ) : data.answered.length === 0 ? (
              <p className="home-empty">
                {data.open ? `${plural(data.open, 'question')} waiting for an answer. ` : 'No answered questions yet. '}
                <a className="link" href={data.open ? '/questions?tab=help' : '/questions'} onClick={onLinkClick}>
                  {data.open ? 'Help answer' : 'Ask other students'}
                </a>
              </p>
            ) : (
              data.answered
                .slice(0, 3)
                .map((question) => (
                  <OverviewRow key={question.id} href={`/questions/${question.id}`} title={question.text} meta={question.answers[0] ? `${question.answers[0].helperName.split(' ')[0]} answered` : relativeDate(question.createdAt)} />
                ))
            ))}
        </OverviewCard>
        <OverviewCard title="Courses" href="/courses">
          {data.courses === null ? (
            <Loading />
          ) : data.courses.total === 0 ? (
            <p className="home-empty">Search every course, section and professor.</p>
          ) : (
            <>
              <OverviewRow href="/courses" title={`${plural(data.courses.total, 'course')} in ${data.courses.term}`} meta={`${data.courses.open} with open seats`} />
              <OverviewRow href="/courses?core=1" title="Core Curriculum" meta="Core courses this term" />
              <OverviewRow href="/threads" title="Group threads" meta="Search the group's old posts" />
            </>
          )}
        </OverviewCard>
      </div>
    </div>
  );
}

/** One section of the site on the home page: its name, a link to all of it, and the latest few things in it. */
function OverviewCard({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  return (
    <section className="home-card">
      <div className="home-card-head">
        <h2>{title}</h2>
        <a className="view-all" href={href} onClick={onLinkClick}>
          View all
        </a>
      </div>
      {children}
    </section>
  );
}

function OverviewRow({ href, title, meta }: { href: string; title: string; meta: string }) {
  return (
    <a className="home-row" href={href} onClick={onLinkClick}>
      <span className="home-row-title">{title}</span>
      {meta && <span className="home-row-meta">{meta}</span>}
    </a>
  );
}

function Loading() {
  return (
    <div className="home-loading" aria-busy="true">
      <span className="skeleton" />
      <span className="skeleton" />
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
  return when.toDateString() === now.toDateString() ? `Today ${formatTime(iso)}` : `${dayName(when, now)} ${formatTime(iso)}`;
}

function dayName(when: Date, now: Date): string {
  if (when.toDateString() === now.toDateString()) return 'Today';
  if (when.toDateString() === new Date(now.getTime() + 86_400_000).toDateString()) return 'Tomorrow';
  return when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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
