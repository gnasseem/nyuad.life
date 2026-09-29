import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, askStream, type SourceCard as Source } from '../api';
import { SourceCard } from '../components/SourceCard';
import { useApp } from '../context';
import { IconCopy, IconPlus, IconSend, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { navigate } from '../router';
import { loadConversations, saveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
  onNeedAccess(): void;
}

export function AskPage({ resumeId, onNeedAccess }: Props) {
  const { home, toast, askPrefill, setAskPrefill } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  useEffect(() => {
    if (!resumeId) return;
    const saved = loadConversations().find((entry) => entry.id === resumeId);
    if (saved) setConversation(saved);
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
      update((c) => ({
        ...c,
        title: c.title || question.slice(0, 80),
        updatedAt: new Date().toISOString(),
        messages: [...c.messages, userMessage, modelMessage],
      }));
      setInput('');
      setRunning(true);
      setFocusMessage(modelMessage.id);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await askStream(
          question,
          history,
          {
            onStatus: (status) => patchMessage(modelMessage.id, { status }),
            onSources: (sources) => patchMessage(modelMessage.id, { sources }),
            onDelta: (text) => patchMessage(modelMessage.id, (message) => ({ content: message.content + text, status: undefined })),
            onFollowups: (followups) => patchMessage(modelMessage.id, { followups }),
          },
          controller.signal,
        );
        patchMessage(modelMessage.id, { pending: false, status: undefined });
        saveConversation({ ...conversationRef.current, updatedAt: new Date().toISOString() });
      } catch (error) {
        if (controller.signal.aborted) {
          patchMessage(modelMessage.id, (message) => ({ pending: false, status: undefined, content: message.content || '', error: message.content ? undefined : 'Stopped.' }));
          if (conversationRef.current.messages.some((m) => m.role === 'model' && m.content && !m.error)) saveConversation(conversationRef.current);
        } else if (error instanceof ApiError && error.status === 401) {
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: 'You need the access code to ask questions.' });
          onNeedAccess();
        } else {
          patchMessage(modelMessage.id, { pending: false, status: undefined, error: error instanceof Error ? error.message : 'Something went wrong.' });
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running, update, patchMessage, onNeedAccess],
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
    element.style.height = `${Math.min(180, element.scrollHeight)}px`;
  }, [input]);

  const stop = () => abortRef.current?.abort();
  const reset = () => {
    abortRef.current?.abort();
    setConversation(fresh());
    setFocusMessage(null);
    setInput('');
    navigate({ name: 'ask' }, { replace: true });
    textareaRef.current?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  };

  const focused = useMemo(() => {
    const byId = focusMessage ? conversation.messages.find((message) => message.id === focusMessage) : undefined;
    return byId?.sources?.length ? byId : [...conversation.messages].reverse().find((message) => message.role === 'model' && message.sources?.length);
  }, [conversation.messages, focusMessage]);
  const sources = focused?.sources ?? [];

  const jumpToSource = (n: number) => {
    setHot(n);
    const element = document.getElementById(`source-${n}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setHot((current) => (current === n ? null : current)), 1600);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy');
    }
  };

  const empty = conversation.messages.length === 0;
  const stats = home?.stats;

  return (
    <div className={`ask-layout${sources.length ? '' : ' single'}`}>
      <div>
        {empty ? (
          <div className="hero">
            <h1 className="display">
              Ask the <em>Room of Requirement</em>
            </h1>
            <p>
              Every answer is built only from what NYUAD students have already posted
              {stats ? ` — ${stats.posts.toLocaleString()} threads and ${stats.comments.toLocaleString()} comments` : ''}, with the original posts cited so you can check for yourself.
            </p>
            {home && (
              <div className="suggest">
                <h3>Try asking</h3>
                <div className="suggest-grid">
                  {home.suggestions.map((suggestion) => (
                    <button key={suggestion.question} type="button" className="suggest-card" onClick={() => void send(suggestion.question)}>
                      <span className="topic">{suggestion.topic.replace('-', ' ')}</span>
                      {suggestion.question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
            <h2 className="display" style={{ fontSize: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {conversation.title}
            </h2>
            <button type="button" className="btn sm" onClick={reset}>
              <IconPlus /> New question
            </button>
          </div>
        )}

        <div className="thread">
          {conversation.messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="turn-user">
                <div className="bubble">{message.content}</div>
              </div>
            ) : (
              <div key={message.id} className="turn-model" onMouseEnter={() => message.sources?.length && setFocusMessage(message.id)}>
                {message.status && (
                  <div className="status-line">
                    <span className="spinner" /> {message.status}…
                  </div>
                )}
                {message.content && (
                  <div className="answer">
                    <Markdown text={message.content} onCitation={jumpToSource} onCitationHover={setHot} hot={hot} />
                    {message.pending && <span className="cursor" />}
                  </div>
                )}
                {message.error && <div className="alert">{message.error}</div>}
                {!message.pending && message.content && (
                  <div className="answer-tools">
                    <button type="button" className="btn ghost sm" onClick={() => void copy(message.content)}>
                      <IconCopy /> Copy
                    </button>
                    {message.sources && message.sources.length > 0 && (
                      <span className="faint small">
                        {message.sources.length} source{message.sources.length === 1 ? '' : 's'} · click a number to see the post
                      </span>
                    )}
                  </div>
                )}
                {!message.pending && message.followups && message.followups.length > 0 && (
                  <div className="followups">
                    {message.followups.map((question) => (
                      <button key={question} type="button" className="followup" onClick={() => void send(question)} disabled={running}>
                        {question}
                      </button>
                    ))}
                  </div>
                )}
                {message.sources && message.sources.length > 0 && (
                  <details className="mobile-sources">
                    <summary className="faint small" style={{ cursor: 'pointer' }}>
                      Show {message.sources.length} sources
                    </summary>
                    <div className="source-list" style={{ marginTop: 10 }}>
                      {message.sources.map((source) => (
                        <SourceCard key={source.n} source={source} hot={hot === source.n} onHover={setHot} />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKey}
              placeholder={empty ? 'Ask about a course, a professor, housing, visas, study away…' : 'Ask a follow-up…'}
              maxLength={600}
              aria-label="Your question"
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
          <div className="composer-hint">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>Answers can be wrong: check the cited posts.</span>
          </div>
        </div>
      </div>

      {sources.length > 0 && (
        <aside className="sources-col desktop-sources">
          <div className="sources-head">
            <h3>Sources</h3>
            <span className="faint small">{sources.length} threads</span>
          </div>
          <div className="source-list">
            {sources.map((source: Source) => (
              <SourceCard key={source.n} source={source} hot={hot === source.n} onHover={setHot} />
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

function fresh(): Conversation {
  const now = new Date().toISOString();
  return { id: uid(), title: '', createdAt: now, updatedAt: now, messages: [] };
}
