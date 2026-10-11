import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, askStream, type SourceCard } from '../api';
import { ChatGPTSignIn } from '../components/ChatGPT';
import { RedirectCard } from '../components/RedirectCard';
import { KIND_LABEL, SourceRow } from '../components/SourceRow';
import { useApp } from '../context';
import { formatDate, plural } from '../format';
import { IconArrow, IconCheck, IconChevron, IconCopy, IconPlus, IconSidebar, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { useMedia } from '../motion';
import { navigate, onLinkClick } from '../router';
import { loadConversations, saveConversation, setActiveConversation, toHistory, uid, type Conversation, type Message } from '../store';

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
            // The server sends the answer as it checked it; an older server sends none, and the streamed text stands.
            onDone: ({ answer, confidence }) => patchMessage(modelMessage.id, (message) => ({ confidence, content: answer ?? stripConfidence(message.content) })),
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
    return <Home composer={composer} historyButton={historyButton} answersOff={Boolean(health && !(health.answers?.available ?? health.gemini.configured) && !chatgpt?.available)} />;
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

const PROMPTS = ['When is the add/drop deadline?', 'How do I get to Dubai?', 'Which dining hall is open latest?'];

/** Ask before the first question: the question, the box and three to start from. */
function Home({ composer, historyButton, answersOff }: { composer: ReactNode; historyButton: ReactNode; answersOff: boolean }) {
  const { setAskPrefill } = useApp();
  return (
    <div className="home">
      {historyButton && <div className="hero-tools">{historyButton}</div>}
      <section className="hero">
        <h1>Ask anything about NYUAD</h1>
        <div className="hero-box">{composer}</div>
        {answersOff && <p className="hero-note">Answers are paused right now. Try again in a little while.</p>}
        <div className="prompts" aria-label="Try a question">
          {PROMPTS.map((question, i) => (
            <button type="button" key={question} style={{ '--i': i } as CSSProperties} onClick={() => setAskPrefill({ question, autoSend: true })}>
              {question}
            </button>
          ))}
        </div>
      </section>
    </div>
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
