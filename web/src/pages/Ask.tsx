import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { askStream, type SourceCard as Source } from '../api';
import { ASK_PLACEHOLDER } from '../brand';
import { Mark } from '../components/Logo';
import { SourceCard } from '../components/SourceCard';
import { useApp } from '../context';
import { compact, formatDate } from '../format';
import { IconArrow, IconChevron, IconCopy, IconPlus, IconSend, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { navigate } from '../router';
import { loadConversations, saveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
}

interface Hot {
  messageId: string;
  n: number;
  rect?: DOMRect;
}

export function AskPage({ resumeId }: Props) {
  const { home, health, toast, askPrefill, setAskPrefill, setBoardPrefill } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => (resumeId && loadConversations().find((entry) => entry.id === resumeId)) || fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [hot, setHot] = useState<Hot | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  useEffect(() => {
    const current = conversationRef.current;
    if (resumeId) {
      if (resumeId === current.id) return;
      const saved = loadConversations().find((entry) => entry.id === resumeId);
      if (saved) setConversation(saved);
    } else if (current.messages.length > 0) {
      abortRef.current?.abort();
      setConversation(fresh());
      setInput('');
      setExpanded(new Set());
    }
  }, [resumeId]);

  const update = useCallback((updater: (current: Conversation) => Conversation) => {
    setConversation((current) => {
      const next = updater(current);
      conversationRef.current = next;
      return next;
    });
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
      const modelMessage: Message = { id: uid(), role: 'model', content: '', pending: true, status: 'Starting' };
      update((c) => ({ ...c, title: c.title || question.slice(0, 80), updatedAt: new Date().toISOString(), messages: [...c.messages, userMessage, modelMessage] }));
      setInput('');
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await askStream(
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
        patchMessage(modelMessage.id, { pending: false, status: undefined });
        const done = { ...conversationRef.current, updatedAt: new Date().toISOString() };
        saveConversation(done);
        navigate({ name: 'ask' }, { replace: true, search: `c=${done.id}`, keepScroll: true });
      } catch (error) {
        if (controller.signal.aborted) {
          patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, error: message.content ? undefined : 'Stopped.' }));
          if (conversationRef.current.messages.some((m) => m.role === 'model' && m.content && !m.error)) saveConversation(conversationRef.current);
        } else {
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: error instanceof Error ? error.message : 'Something went wrong.' });
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running, update, patchMessage],
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
    element.style.height = `${Math.min(200, element.scrollHeight)}px`;
  }, [input]);

  const stop = () => abortRef.current?.abort();
  const startNew = () => navigate({ name: 'ask' });

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
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

  const jumpToSource = (messageId: string, n: number) => {
    setExpanded((current) => new Set(current).add(messageId));
    setHot({ messageId, n });
    window.setTimeout(() => {
      document.getElementById(`source-${messageId}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
    window.setTimeout(() => setHot((current) => (current?.messageId === messageId && current.n === n && !current.rect ? null : current)), 1800);
  };

  const askStudents = (question: string) => {
    setBoardPrefill(question);
    navigate({ name: 'questions' });
  };

  const empty = conversation.messages.length === 0;
  const popover = useMemo(() => {
    if (!hot?.rect) return null;
    const message = conversation.messages.find((entry) => entry.id === hot.messageId);
    const source = message?.sources?.find((entry) => entry.n === hot.n);
    if (!source) return null;
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(16, Math.min(hot.rect.left, window.innerWidth - width - 16));
    const below = hot.rect.bottom + 8;
    const style = below + 180 < window.innerHeight ? { top: below, left } : { bottom: window.innerHeight - hot.rect.top + 8, left };
    return (
      <div className="cite-pop" style={style}>
        <SourceCard source={source} hot />
      </div>
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
        placeholder={empty ? ASK_PLACEHOLDER : 'Ask a follow-up'}
        maxLength={600}
        aria-label="Your question"
        autoFocus={window.matchMedia('(min-width: 900px)').matches}
      />
      {running ? (
        <button type="button" className="send stop" onClick={stop} aria-label="Stop">
          <IconStop />
        </button>
      ) : (
        <button type="button" className="send" onClick={() => void send(input)} disabled={!input.trim()} aria-label="Send">
          <IconSend />
        </button>
      )}
    </div>
  );

  if (empty) {
    return (
      <div className="page ask">
        <div className="hero">
          <Mark className="hero-mark" />
          <h1 className="greeting">What do you need?</h1>
          <p className="hero-sub">
            {home ? `Answers from ${compact(home.stats.posts)} Room of Requirement threads${health?.official?.pages ? `, ${compact(health.official.pages)} official NYUAD pages` : ''} and the students who answer here, with sources.` : 'Answers from what the Room of Requirement already worked out, official NYUAD pages and the students who answer here.'}
          </p>
          {composer}
          {home && home.suggestions.length > 0 && (
            <div className="starters">
              {home.suggestions.slice(0, 4).map((suggestion) => (
                <button key={suggestion.question} type="button" className="starter" onClick={() => void send(suggestion.question)}>
                  {suggestion.question}
                </button>
              ))}
            </div>
          )}
          {home && (
            <div className="hero-stats">
              <span>
                <b>{home.stats.posts.toLocaleString()}</b> threads
              </span>
              <span>
                <b>{home.stats.comments.toLocaleString()}</b> comments
              </span>
              {home.stats.newestPost && (
                <span>
                  newest <b>{formatDate(home.stats.newestPost)}</b>
                </span>
              )}
            </div>
          )}
          {health && !health.gemini.configured && <p className="ask-note">Answers are switched off on this server until a model key is added. Search still works.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="page ask">
      <div className="conversation-head">
        <button type="button" className="btn ghost sm" onClick={startNew}>
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
            <div key={message.id} className="turn model">
              <Mark className="avatar-mark" />
              <div className="body">
                {message.status && (
                  <div className="status-line">
                    <span className="spinner" /> {message.status}
                  </div>
                )}
                {message.redirect && (
                  <div className="redirect">
                    <h3>{message.redirect.title}</h3>
                    <p>{message.redirect.message}</p>
                    <div className="row" style={{ marginTop: 6 }}>
                      <a className="btn primary" href={message.redirect.link.url} target="_blank" rel="noreferrer">
                        {message.redirect.link.label}
                      </a>
                    </div>
                  </div>
                )}
                {message.content && (
                  <div className="answer">
                    <Markdown
                      text={message.content}
                      hot={hot?.messageId === message.id ? hot.n : null}
                      onCitation={(n) => jumpToSource(message.id, n)}
                      onCitationHover={(n, rect) => setHot(n === null ? null : { messageId: message.id, n, rect })}
                    />
                    {message.pending && <span className="cursor" />}
                  </div>
                )}
                {message.error && <div className="alert">{message.error}</div>}
                {!message.pending && message.content && (
                  <div className="answer-foot">
                    {message.confidence && (
                      <span className={`pill confidence ${message.confidence.level}`} title={message.confidence.reason}>
                        <span className="dot" /> {message.confidence.level === 'high' ? 'High' : message.confidence.level === 'medium' ? 'Medium' : 'Low'} confidence
                      </span>
                    )}
                    {message.confidence?.reason && <span className="faint">{message.confidence.reason}</span>}
                    {message.sources && message.sources.length > 0 && (
                      <button type="button" className={`foot-btn${expanded.has(message.id) ? ' open' : ''}`} onClick={() => toggleSources(message.id)} aria-expanded={expanded.has(message.id)}>
                        {message.sources.length} {message.sources.length === 1 ? 'source' : 'sources'} <IconChevron className="chev" />
                      </button>
                    )}
                    <button type="button" className="foot-btn" onClick={() => void copy(message.content)}>
                      <IconCopy /> Copy
                    </button>
                    {(!message.confidence || message.confidence.level !== 'high') && (
                      <button type="button" className="foot-btn" onClick={() => askStudents(questionBefore(conversation.messages, message.id))}>
                        Ask students <IconArrow />
                      </button>
                    )}
                  </div>
                )}
                {message.sources && message.sources.length > 0 && expanded.has(message.id) && (
                  <div className="sources-panel">
                    {message.sources.map((source: Source) => (
                      <SourceCard key={source.n} id={`source-${message.id}-${source.n}`} source={source} hot={hot?.messageId === message.id && hot.n === source.n} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />
                    ))}
                  </div>
                )}
                {!message.pending && message.followups && message.followups.length > 0 && (
                  <div className="followups">
                    {message.followups.map((question) => (
                      <button key={question} type="button" className="followup" onClick={() => void send(question)} disabled={running}>
                        {question} <IconArrow />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <div className="composer-wrap">{composer}</div>
      {popover}
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
