import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, askStream, type Announcement, type FeedQuestion, type Listing, type MarketSummary, type QuestionWithAnswers, type SourceCard } from '../api';
import { ChatGPTLine, ChatGPTSignIn } from '../components/ChatGPT';
import { Flap } from '../components/Flap';
import { RedirectCard } from '../components/RedirectCard';
import { KIND_LABEL, SourceRow } from '../components/SourceRow';
import { useApp } from '../context';
import { formatDate, formatTime, plural, relativeDate, startsIn } from '../format';
import { IconArrow, IconCheck, IconChevron, IconCopy, IconPlus, IconSidebar, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { useMedia, useNow } from '../motion';
import { navigate, onLinkClick } from '../router';
import { askerKey, loadConversations, loadSeenAnswers, saveConversation, saveSeenAnswers, setActiveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
  /** The conversation list beside Ask: whether it is showing, how many it holds, and the button that folds it. */
  history: { open: boolean; count: number; toggle(): void };
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

export function AskPage({ resumeId, history }: Props) {
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

  const wide = useMedia('(min-width: 1100px)');
  // Beside Ask on a wide screen the list has its own fold button; folded away, or on a phone, this brings it back.
  const historyButton =
    history.count > 0 && (!wide || !history.open) ? (
      <button type="button" className="icon-btn history-btn" onClick={history.toggle} aria-label="Your conversations" title="Your conversations" aria-controls="conversation-history" aria-expanded={history.open}>
        <IconSidebar />
      </button>
    ) : null;

  const composer = (
    <div className={`composer${empty ? ' big' : ''}`}>
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKey}
        placeholder={empty ? 'Ask about a course, a professor, housing, visas…' : 'Ask a follow-up'}
        maxLength={600}
        aria-label="Your question"
        enterKeyHint="send"
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
    return <Home composer={composer} historyButton={historyButton} history={history} wide={wide} answersOff={Boolean(health && !(health.answers?.available ?? health.gemini.configured) && !chatgpt?.available)} />;
  }

  return (
    <div className="conv">
      <div className="conv-main">
        <div className="conv-head">
          {historyButton}
          <h1 className="conv-title" title={conversation.title}>
            {conversation.title || 'New question'}
          </h1>
          <button
            type="button"
            className="btn sm new-chat"
            onClick={() => {
              reset();
              setActiveConversation(null);
              navigate({ name: 'ask' });
            }}
          >
            <IconPlus /> <span>New</span>
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
                {message.sources && message.sources.length > 0 && !message.redirect && <SourceStrip sources={message.sources} hot={hot?.messageId === message.id ? hot.n : null} onPick={(n) => jumpToSource(message.id, n)} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />}
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
                      <span className={`confidence ${message.confidence.level}`} title={message.confidence.reason || undefined}>
                        <span className="dot" /> {CONFIDENCE_LABEL[message.confidence.level]}
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
                      <button type="button" className="foot-btn ask-students" onClick={() => askStudents(questionBefore(conversation.messages, message.id))}>
                        Ask students <IconArrow />
                      </button>
                    )}
                  </div>
                )}
                {!message.pending && message.confidence?.reason && message.confidence.level !== 'high' && <p className="confidence-reason">{message.confidence.reason}</p>}
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

/**
 * The sources as stops on a line, above the answer: they arrive before the first word, so the student sees what the
 * answer rests on while it is written. A stop opens the full list at that source.
 */
function SourceStrip({ sources, hot, onPick, onHover }: { sources: SourceCard[]; hot: number | null; onPick(n: number): void; onHover(n: number | null): void }) {
  return (
    <div className="source-strip" aria-label={`${plural(sources.length, 'source')}`}>
      <ol>
        {sources.map((source) => (
          <li key={source.n} data-kind={source.kind}>
            <button type="button" className={hot === source.n ? 'hot' : undefined} onClick={() => onPick(source.n)} onMouseEnter={() => onHover(source.n)} onMouseLeave={() => onHover(null)} title={source.title || source.snippet}>
              <span className="strip-n">{source.n}</span>
              <span className="strip-text">
                <b>{KIND_LABEL[source.kind]}</b>
                <span>{stripTitle(source)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A few words that tell one source from another: its title, else the start of its passage. */
function stripTitle(source: SourceCard): string {
  const text = (source.title || source.snippet || source.text || '').replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 46).trimEnd()}…` : text || (source.date ? formatDate(source.date) : '');
}

/** The server's current step, with the steps still to come, without inventing a completion percentage. */
function Route({ status }: { status: string }) {
  const stage = STAGES.findIndex((entry) => entry.match.test(status));
  return (
    <div className="ask-process" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="process-status">{status}</span>
      <span className="process-steps" aria-hidden="true">
        {STAGES.map((entry, index) => (
          <i key={entry.label} className={stage > index ? 'done' : stage === index ? 'now' : ''} />
        ))}
      </span>
    </div>
  );
}

const PROMPTS = ['How does course registration work?', 'When is the add/drop deadline?', 'How do I get to Dubai from campus?', 'What are the pool hours?'];

interface HomeData {
  notices: Announcement[] | null;
  rides: Listing[] | null;
  listings: number;
  markets: Array<{ currency: 'falcon' | 'campus'; label: string; summary: MarketSummary }>;
  feed: FeedQuestion[] | null;
  mine: QuestionWithAnswers[];
}

function useHomeData(): HomeData & { refreshFeed(): void } {
  const { boardProblem, profile } = useApp();
  const [data, setData] = useState<HomeData>({ notices: null, rides: null, listings: 0, markets: [], feed: null, mine: [] });
  const set = useCallback((patch: Partial<HomeData>) => setData((current) => ({ ...current, ...patch })), []);
  const refreshFeed = useCallback(() => {
    api.board
      .feed()
      .then((result) => set({ feed: result.questions }))
      .catch(() => set({ feed: [] }));
  }, [set]);
  useEffect(() => {
    if (boardProblem) return;
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
    refreshFeed();
  }, [boardProblem, set, refreshFeed]);
  useEffect(() => {
    if (boardProblem || !profile) return;
    api.board
      .mine()
      .then((result) => set({ mine: result.questions }))
      .catch(() => set({ mine: [] }));
  }, [boardProblem, profile?.netId, set]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...data, refreshFeed };
}

function greeting(now: Date): string {
  const hour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hour12: false }));
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function Home({ composer, historyButton, history, wide, answersOff }: { composer: ReactNode; historyButton: ReactNode; history: Props['history']; wide: boolean; answersOff: boolean }) {
  const { boardProblem, setAskPrefill, profile, health } = useApp();
  const data = useHomeData();
  const now = useNow();
  const posts = health?.archive?.posts ?? 0;
  const recent = useMemo(() => (history.count ? loadConversations().slice(0, 3) : []), [history.count]);
  const showRecent = recent.length > 0 && (!wide || !history.open);

  return (
    <div className="home">
      <section className="hero">
        {historyButton && <div className="hero-tools">{historyButton}</div>}
        <h1>Ask anything about NYUAD</h1>
        <p className="hero-sub">
          {greeting(now)}
          {profile ? `, ${profile.name.split(' ')[0]}` : ''}. Answers come from official pages, the Albert schedule{posts > 1000 ? ` and ${(Math.floor(posts / 1000) * 1000).toLocaleString()}+ Room of Requirement threads` : ' and the Room of Requirement'}, with every source linked.
        </p>
        {composer}
        {answersOff && <p className="hero-note">Answers are paused right now. Search the group's threads in Reviews meanwhile.</p>}
        <ChatGPTLine tone="light" />
        <div className="prompts" aria-label="Try a question">
          {PROMPTS.map((question) => (
            <button type="button" key={question} onClick={() => setAskPrefill({ question, autoSend: true })}>
              {question}
            </button>
          ))}
        </div>
      </section>

      {showRecent && (
        <section className="recent" aria-label="Recent conversations">
          <div className="block-head">
            <h2>Pick up where you left off</h2>
            <button type="button" className="link-btn" onClick={history.toggle}>
              All {history.count}
            </button>
          </div>
          <div className="recent-list">
            {recent.map((conversation) => (
              <a key={conversation.id} href={`/?c=${conversation.id}`} onClick={onLinkClick}>
                <b>{conversation.title || 'Untitled'}</b>
                <span>{relativeDate(conversation.updatedAt)}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {boardProblem ? null : (
        <div className="campus">
          <div className="campus-main">
            <NewAnswers mine={data.mine} />
            <HelpBlock feed={data.feed} onChanged={data.refreshFeed} />
          </div>
          <aside className="campus-side">
            <EventsBlock notices={data.notices} now={now} />
            <MarketBlock rides={data.rides} listings={data.listings} markets={data.markets} now={now} />
          </aside>
        </div>
      )}
    </div>
  );
}

/** Your own questions that got answers since you last looked. */
function NewAnswers({ mine }: { mine: QuestionWithAnswers[] }) {
  const [seen, setSeen] = useState(loadSeenAnswers);
  // A question seen for the first time here counts its answers as read, so only answers that arrive later are news.
  useEffect(() => {
    if (!mine.length) return;
    const next = { ...seen };
    let changed = false;
    for (const question of mine) {
      if (next[question.id] === undefined) {
        next[question.id] = question.answers.length;
        changed = true;
      }
    }
    if (changed) {
      saveSeenAnswers(next);
      setSeen(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);
  const fresh = mine.filter((question) => seen[question.id] !== undefined && question.answers.length > seen[question.id]!);
  if (!fresh.length) return null;
  const markSeen = (question: QuestionWithAnswers) => {
    const next = { ...seen, [question.id]: question.answers.length };
    saveSeenAnswers(next);
    setSeen(next);
  };
  return (
    <div className="news">
      {fresh.slice(0, 2).map((question) => {
        const count = question.answers.length - seen[question.id]!;
        const latest = question.answers.at(-1);
        return (
          <a key={question.id} className="news-item" href={`/questions/${question.id}`} onClick={(event) => { markSeen(question); onLinkClick(event); }}>
            <span className="news-badge">{count === 1 ? 'New answer' : `${count} new answers`}</span>
            <b>{question.text}</b>
            {latest && (
              <span className="news-quote">
                {latest.helperName.split(' ')[0]}: {latest.text.slice(0, 140)}
                {latest.text.length > 140 ? '…' : ''}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

/** Questions other students are waiting on, best fit first, answerable right here. */
function HelpBlock({ feed, onChanged }: { feed: FeedQuestion[] | null; onChanged(): void }) {
  const { profile } = useApp();
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const open = useMemo(() => {
    const fit = (question: FeedQuestion) =>
      (question.answers.length === 0 ? 10 : 0) + (profile && question.majors.includes(profile.major) ? 3 : 0) + (profile && question.years.includes(profile.year) ? 2 : 0) + Date.parse(question.createdAt) / 1e13;
    return (feed ?? [])
      .filter((question) => !question.mine && !question.byMe && question.status !== 'closed' && question.answers.length < 3 && !gone.has(question.id))
      .sort((a, b) => fit(b) - fit(a))
      .slice(0, 3);
  }, [feed, profile, gone]);
  const answered = (feed ?? []).filter((question) => question.answers.length > 0 && question.status !== 'closed').slice(0, 3);
  const drop = (id: string) => setGone((current) => new Set(current).add(id));

  return (
    <section className="block help" data-line="questions">
      <div className="block-head">
        <h2>{open.length || !answered.length ? 'Students are asking' : 'Recently answered'}</h2>
        <a className="link-btn" href="/questions" onClick={onLinkClick}>
          All questions
        </a>
      </div>
      {feed === null ? (
        <Loading />
      ) : open.length ? (
        <div className="help-list">
          {open.map((question) => (
            <HelpItem key={question.id} question={question} onDone={() => { drop(question.id); onChanged(); }} onSkip={() => drop(question.id)} />
          ))}
        </div>
      ) : answered.length ? (
        <div className="help-list">
          {answered.map((question) => (
            <a key={question.id} className="help-item link" href={`/questions/${question.id}`} onClick={onLinkClick}>
              <b>{question.text}</b>
              <span className="help-meta">
                {question.answers[0]!.helperName.split(' ')[0]} answered · {plural(question.answers.length, 'answer')}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="block-empty">
          Nobody is waiting on an answer. When Ask cannot help,{' '}
          <a href="/questions" onClick={onLinkClick}>
            ask other students
          </a>
          .
        </p>
      )}
    </section>
  );
}

function HelpItem({ question, onDone, onSkip }: { question: FeedQuestion; onDone(): void; onSkip(): void }) {
  const { profile, setProfile, toast } = useApp();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fits = profile ? question.majors.includes(profile.major) || question.years.includes(profile.year) : false;

  const send = async () => {
    if (!profile || text.trim().length < 2 || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.answer({ netId: profile.netId, questionId: question.id, text: text.trim() });
      setProfile({ ...profile, answers: result.answered });
      toast(result.answered === 1 ? 'Your first answer is up. Thank you.' : `Answer posted. You have helped ${result.answered} students.`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the answer.');
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    if (profile) void api.board.skip({ netId: profile.netId, questionId: question.id }).catch(() => {});
    onSkip();
  };

  return (
    <article className={`help-item${writing ? ' writing' : ''}`}>
      <a className="help-q" href={`/questions/${question.id}`} onClick={onLinkClick}>
        {question.text}
      </a>
      <span className="help-meta">
        {fits && <span className="help-fit">For you</span>}
        {question.askerName || 'A student'} · {relativeDate(question.createdAt)} · {question.answers.length ? plural(question.answers.length, 'answer') : 'No answers yet'}
      </span>
      {writing ? (
        <div className="help-write">
          <textarea
            className="input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="What you know: be specific, and say when it was"
            rows={3}
            maxLength={1200}
            aria-label="Your answer"
            autoFocus
          />
          {error && <div className="alert error">{error}</div>}
          <div className="help-actions">
            <button type="button" className="btn ghost sm" onClick={() => setWriting(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary sm" onClick={() => void send()} disabled={busy || text.trim().length < 2}>
              {busy ? 'Sending' : 'Post answer'}
            </button>
          </div>
        </div>
      ) : (
        <div className="help-actions">
          <button type="button" className="btn sm" onClick={() => setWriting(true)}>
            I know this
          </button>
          <button type="button" className="btn ghost sm" onClick={skip}>
            Skip
          </button>
        </div>
      )}
    </article>
  );
}

function EventsBlock({ notices, now }: { notices: Announcement[] | null; now: Date }) {
  const upcoming = (notices ?? []).filter((entry) => entry.kind === 'event' && entry.startsAt && Date.parse(entry.startsAt) > now.getTime() - 3 * 3_600_000).slice(0, 3);
  return (
    <section className="block" data-line="notices">
      <div className="block-head">
        <h2>Coming up</h2>
        <a className="link-btn" href="/events" onClick={onLinkClick}>
          Events
        </a>
      </div>
      {notices === null ? (
        <Loading />
      ) : upcoming.length === 0 ? (
        <p className="block-empty">
          Nothing posted yet.{' '}
          <a href="/events" onClick={onLinkClick}>
            Post an event
          </a>
        </p>
      ) : (
        <div className="mini-list">
          {upcoming.map((entry) => (
            <a key={entry.id} className="mini" href="/events" onClick={onLinkClick}>
              <span className="mini-when">{noticeWhen(entry, now)}</span>
              <span className="mini-what">{entry.title}</span>
              {entry.location && <span className="mini-where">{entry.location}</span>}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function MarketBlock({ rides, listings, markets, now }: { rides: Listing[] | null; listings: number; markets: HomeData['markets']; now: Date }) {
  return (
    <section className="block" data-line="market">
      <div className="block-head">
        <h2>Market</h2>
        <a className="link-btn" href="/market" onClick={onLinkClick}>
          {listings ? `${plural(listings, 'listing')}` : 'Open'}
        </a>
      </div>
      {rides === null ? (
        <Loading />
      ) : (
        <>
          {rides.length > 0 && (
            <div className="mini-list">
              {rides.slice(0, 2).map((ride) => {
                const soon = startsIn(new Date(ride.happensAt!), now, 60);
                return (
                  <a key={ride.id} className="mini" href="/market/rides" onClick={onLinkClick}>
                    <span className="mini-when">{soon?.live ? 'Leaving now' : rideWhen(ride.happensAt!, now)}</span>
                    <span className="mini-what">Ride to {ride.destination}</span>
                  </a>
                );
              })}
            </div>
          )}
          {markets.map(({ currency, label, summary }) => (
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
          {rides.length === 0 && markets.length === 0 && (
            <p className="block-empty">
              No rides or trades right now.{' '}
              <a href="/market/rides" onClick={onLinkClick}>
                Share a ride
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Loading() {
  return (
    <div className="block-empty">
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
