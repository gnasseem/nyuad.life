import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { askStream } from '../api';
import { SourceRow } from '../components/SourceRow';
import { useApp } from '../context';
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

const CONFIDENCE_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

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
          patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, error: message.content ? undefined : 'Stopped' }));
          if (conversationRef.current.messages.some((m) => m.role === 'model' && m.content && !m.error)) saveConversation(conversationRef.current);
        } else {
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: error instanceof Error ? error.message : 'The request failed.' });
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
      <div className="popover" style={style}>
        <SourceRow source={source} hot />
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
        placeholder={empty ? 'Ask a question' : 'Ask a follow-up'}
        maxLength={600}
        aria-label="Your question"
        autoFocus={window.matchMedia('(min-width: 900px)').matches}
      />
      {running ? (
        <button type="button" className="send" onClick={stop} aria-label="Stop">
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
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Ask</h1>
            <p>Answers from Room of Requirement threads, official NYUAD pages and student answers, with sources.</p>
          </div>
        </div>
        {composer}
        {home && home.suggestions.length > 0 && (
          <div className="starters">
            {home.suggestions.slice(0, 3).map((suggestion) => (
              <button key={suggestion.question} type="button" onClick={() => void send(suggestion.question)}>
                {suggestion.question}
              </button>
            ))}
          </div>
        )}
        {health && !health.gemini.configured && (
          <div className="alert" style={{ marginTop: 16 }}>
            Answers are off: no model key is set on this server.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page ask">
      <div className="conversation-head">
        <button type="button" className="btn ghost sm" onClick={() => navigate({ name: 'ask' })}>
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
              {message.status && (
                <div className="status-line">
                  <span className="spinner" /> {message.status}
                </div>
              )}
              {message.redirect && (
                <div className="alert">
                  <b>{message.redirect.title}</b>
                  {message.redirect.message}
                  <br />
                  <a className="link" href={message.redirect.link.url} target={message.redirect.link.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
                    {message.redirect.link.label}
                  </a>
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
              {message.error && <div className="alert error">{message.error}</div>}
              {!message.pending && message.content && (
                <div className="answer-foot">
                  {message.confidence && (
                    <span className={`status confidence ${message.confidence.level}`} title={message.confidence.reason}>
                      <span className="dot" /> {CONFIDENCE_LABEL[message.confidence.level]}
                    </span>
                  )}
                  {message.confidence?.reason && <span>{message.confidence.reason}</span>}
                  {message.sources && message.sources.length > 0 && (
                    <button type="button" className="foot-btn" onClick={() => toggleSources(message.id)} aria-expanded={expanded.has(message.id)}>
                      {message.sources.length} {message.sources.length === 1 ? 'source' : 'sources'} <IconChevron style={expanded.has(message.id) ? { transform: 'rotate(180deg)' } : undefined} />
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
                <div className="list">
                  {message.sources.map((source) => (
                    <SourceRow key={source.n} id={`source-${message.id}-${source.n}`} source={source} hot={hot?.messageId === message.id && hot.n === source.n} onHover={(n) => setHot(n === null ? null : { messageId: message.id, n })} />
                  ))}
                </div>
              )}
              {!message.pending && message.followups && message.followups.length > 0 && (
                <div className="list">
                  {message.followups.map((question) => (
                    <button key={question} type="button" className="list-row" onClick={() => void send(question)} disabled={running}>
                      <span className="grow">{question}</span>
                      <IconArrow className="chev" />
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
