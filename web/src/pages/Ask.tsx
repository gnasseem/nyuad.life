import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { askStream, type SourceCard as Source } from '../api';
import { SourceCard } from '../components/SourceCard';
import { useApp } from '../context';
import { plural, topicLabel } from '../format';
import { IconCopy, IconPlus, IconSend, IconStop } from '../icons';
import { Markdown } from '../markdown';
import { navigate } from '../router';
import { loadConversations, saveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
}

export function AskPage({ resumeId }: Props) {
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

  const composer = (
    <div className={`composer-wrap${empty ? ' inline' : ''}`}>
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKey}
          placeholder={empty ? 'Ask about a course, a professor, housing, visas, study away…' : 'Ask a follow-up'}
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
        <span>Enter to send, Shift+Enter for a new line</span>
        <span>Answers can be wrong. Check the cited posts.</span>
      </div>
    </div>
  );

  return (
    <div className={`ask${sources.length ? '' : ' single'}`}>
      <div>
        {empty ? (
          <>
            <section className="hero">
              <h1>Ask the Room of Requirement archive</h1>
              <p>
                {stats ? `Search ${plural(stats.posts, 'thread')} and ${plural(stats.comments, 'comment')} from the NYU Abu Dhabi student group.` : 'Search the NYU Abu Dhabi student group.'} Every
                answer cites the original posts so you can check it yourself.
              </p>
            </section>
            {composer}
            {home && home.suggestions.length > 0 && (
              <section className="examples" aria-labelledby="examples-title">
                <h2 id="examples-title">Example questions</h2>
                <div className="examples-grid">
                  {home.suggestions.map((suggestion) => (
                    <button key={suggestion.question} type="button" className="example" onClick={() => void send(suggestion.question)}>
                      <span className="k">{topicLabel(suggestion.topic)}</span>
                      <span>{suggestion.question}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="conversation-head">
            <h2>{plural(conversation.messages.filter((message) => message.role === 'user').length, 'question')} in this conversation</h2>
            <button type="button" className="btn sm" onClick={reset}>
              <IconPlus /> New question
            </button>
          </div>
        )}

        {!empty && (
          <div className="thread">
            {conversation.messages.map((message) =>
              message.role === 'user' ? (
                <h3 key={message.id} className="question">
                  {message.content}
                </h3>
              ) : (
                <div key={message.id} className="turn" onMouseEnter={() => message.sources?.length && setFocusMessage(message.id)}>
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
                      {message.sources && message.sources.length > 0 && <span className="faint small">Based on {plural(message.sources.length, 'thread')}. Click a number to see the post.</span>}
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
                    <details className="sources-inline">
                      <summary>Sources ({message.sources.length})</summary>
                      <div className="source-list">
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
        )}

        {!empty && composer}
      </div>

      {sources.length > 0 && (
        <aside className="sources" aria-label="Sources">
          <div className="sources-head">
            <h2>Sources</h2>
            <span className="faint small">{plural(sources.length, 'thread')}</span>
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
