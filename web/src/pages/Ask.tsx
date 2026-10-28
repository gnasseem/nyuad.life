import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, askStream, warmAsk, type Question, type QuestionWithAnswers, type SourceCard } from '../api';
import { AdminRemove } from '../components/AdminRemove';
import { ChatGPTSignIn } from '../components/ChatGPT';
import { RedirectCard } from '../components/RedirectCard';
import { KIND_LABEL, SourceRow } from '../components/SourceRow';
import { useApp } from '../context';
import { formatDate, initials, plural, relativeDate } from '../format';
import { IconArrow, IconChat, IconCheck, IconChevron, IconCopy, IconPlus, IconSidebar, IconStop, IconThumbDown, IconThumbUp, IconUsers } from '../icons';
import { Markdown } from '../markdown';
import { useMedia } from '../motion';
import { navigate, onLinkClick } from '../router';
import { askerKey, loadConversations, saveConversation, setActiveConversation, toHistory, uid, type Conversation, type Message } from '../store';

interface Props {
  resumeId?: string;
  /** The conversation list beside Ask: whether it is showing, how many it holds, and the button that folds it. */
  history: { open: boolean; count: number; unread: number; toggle(): void };
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
  const { health, toast, askPrefill, setAskPrefill, chatgpt, refreshChatGPT, students } = useApp();
  const [conversation, setConversation] = useState<Conversation>(() => (resumeId && loadConversations().find((entry) => entry.id === resumeId)) || fresh());
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [departing, setDeparting] = useState(0);
  const [hot, setHot] = useState<Hot | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [reporting, setReporting] = useState(false);
  const [posting, setPosting] = useState<string | null>(null);
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
    warmAsk();
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
            onReplace: (text) => patchMessage(modelMessage.id, { content: text, status: undefined }),
            onDone: ({ confidence }) => patchMessage(modelMessage.id, (message) => ({ confidence, content: stripConfidence(message.content) })),
            onLog: (logId) => patchMessage(modelMessage.id, { logId }),
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

  /** Thumbs on an answer: kept with the conversation and sent to the admins' Ask log. Tapping the same one again clears it. */
  const vote = (modelId: string, value: 'up' | 'down') => {
    const message = conversationRef.current.messages.find((entry) => entry.id === modelId);
    if (!message) return;
    const next = message.vote === value ? undefined : value;
    patchMessage(modelId, { vote: next });
    saveConversation(conversationRef.current);
    if (message.logId) void api.markAnswer(message.logId, { vote: next ?? null }).catch(() => undefined);
    if (next === 'down') toast('Thanks. The admins will look at it.');
  };

  /** Posts the question this answer was for to students, anonymously; their answers then show up under it. */
  const askStudents = async (modelId: string) => {
    const question = questionBefore(conversationRef.current.messages, modelId);
    if (!question || posting) return;
    setPosting(modelId);
    try {
      const result = await api.board.ask({ text: question, key: askerKey() });
      if (result.question) {
        // A question the answer did not settle: flagged in the admins' Ask log.
        const logId = conversationRef.current.messages.find((message) => message.id === modelId)?.logId;
        if (logId) void api.markAnswer(logId, { asked: true }).catch(() => undefined);
        const similar = (result.similar ?? []).filter((entry) => entry.answers.length).slice(0, 2).map((entry) => ({ text: entry.text, answer: entry.answers[0]!.text }));
        patchMessage(modelId, { asked: { id: result.question.id, at: result.question.createdAt, similar } });
        saveConversation(conversationRef.current);
        students.refresh();
      } else if (result.redirect) {
        patchMessage(modelId, { redirect: result.redirect });
        saveConversation(conversationRef.current);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not ask students. Try again.');
    } finally {
      setPosting(null);
    }
  };

  // "Ask students" sits under the latest answer, and under any earlier one the student marked down.
  const lastAnswerId = [...conversation.messages].reverse().find((message) => message.role === 'model')?.id;

  // Answers students sent to this conversation's questions count as read once they are on screen.
  const askedIds = conversation.messages.flatMap((message) => (message.asked ? [message.asked.id] : []));
  const askedKey = askedIds.join(',');
  useEffect(() => {
    if (askedIds.length) students.markSeen(askedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedKey, students.markSeen]);

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
      <button type="button" className="icon-btn history-btn" onClick={history.toggle} aria-label={history.unread ? 'Your conversations, with new answers from students' : 'Your conversations'} title="Your conversations" aria-controls="conversation-history" aria-expanded={history.open}>
        <IconSidebar />
        {history.unread > 0 && <span className="history-dot" aria-hidden="true" />}
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
        onFocus={warmAsk}
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
                {message.redirect && (message.redirect.domain === 'live' ? !message.asked && <RedirectCard redirect={message.redirect} onAction={() => void askStudents(message.id)} busy={posting === message.id} /> : <RedirectCard redirect={message.redirect} />)}
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
                        {!message.asked && (
                          <button type="button" className="link-btn" onClick={() => void askStudents(message.id)} disabled={posting === message.id}>
                            {posting === message.id ? 'Asking students…' : 'Ask students'}
                          </button>
                        )}
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
                    <button type="button" className="foot-btn" onClick={() => { setReportId(reportId === message.id ? null : message.id); setReportReason(''); }}>Report<span className="wide-only"> answer</span></button>
                    <span className="votes" role="group" aria-label="Was this helpful?">
                      <button type="button" className={`foot-btn vote${message.vote === 'up' ? ' on' : ''}`} onClick={() => vote(message.id, 'up')} aria-pressed={message.vote === 'up'} title="Helpful">
                        <IconThumbUp />
                      </button>
                      <button type="button" className={`foot-btn vote${message.vote === 'down' ? ' on' : ''}`} onClick={() => vote(message.id, 'down')} aria-pressed={message.vote === 'down'} title="Not helpful">
                        <IconThumbDown />
                      </button>
                    </span>
                  </div>
                )}
                {reportId === message.id && !message.pending && message.content && (
                  <div className="report-answer">
                    <label htmlFor={`report-${message.id}`}>What was wrong with this answer?</label>
                    <textarea id={`report-${message.id}`} className="input" rows={2} maxLength={1000} value={reportReason} onChange={(event) => setReportReason(event.target.value)} placeholder="Incorrect fact, missed review, outdated professor…" />
                    <button type="button" className="btn sm primary" disabled={!reportReason.trim() || reporting} onClick={() => {
                      setReporting(true);
                      void api.reportAnswer(questionBefore(conversation.messages, message.id), message.content, reportReason.trim(), (message.sources ?? []).map((source) => source.url).filter(Boolean), message.logId)
                        .then(() => { setReportId(null); setReportReason(''); toast('Report saved for the admins'); })
                        .catch((error) => toast(error instanceof Error ? error.message : 'Could not save the report.'))
                        .finally(() => setReporting(false));
                    }}>{reporting ? 'Saving…' : 'Send report'}</button>
                  </div>
                )}
                {!message.pending && message.confidence?.reason && message.confidence.level !== 'high' && <p className="confidence-reason">{message.confidence.reason}</p>}
                {!message.pending && message.content && !message.asked && !message.redirect && (message.id === lastAnswerId || message.vote === 'down') && (
                  <div className={`ask-bar${message.vote === 'down' || (message.confidence && message.confidence.level !== 'high') ? ' strong' : ''}`} data-line="questions">
                    <IconUsers />
                    <p>
                      <b>{message.vote === 'down' ? 'Sorry it missed.' : message.confidence?.level === 'high' ? 'Want a second opinion?' : 'Not sure this is right?'}</b>{' '}
                      Students who have been through it can answer, anonymously.
                    </p>
                    <button type="button" className="btn sm" onClick={() => void askStudents(message.id)} disabled={posting === message.id}>
                      {posting === message.id ? 'Asking…' : <>Ask students <IconArrow /></>}
                    </button>
                  </div>
                )}
                {message.asked && <StudentReplies asked={message.asked} question={students.questions.get(message.asked.id)} />}
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
      <CanYouAnswer />
    </div>
  );
}

/** What students said to a question put to them from this answer, or that it is waiting for them. */
function StudentReplies({ asked, question }: { asked: NonNullable<Message['asked']>; question?: QuestionWithAnswers }) {
  const answers = question?.answers ?? [];
  return (
    <section className="students" data-line="questions" aria-label="Answers from students">
      <div className="students-head">
        <IconChat />
        <b>{answers.length ? `${plural(answers.length, 'student')} answered` : 'Asked students'}</b>
        <span>{relativeDate(asked.at)}</span>
      </div>
      {answers.length === 0 && <p className="students-wait">Students who might know will see it. Their answers appear here and in your conversations.</p>}
      {answers.map((answer) => (
        <div key={answer.id} className="students-answer">
          <span className="meta">
            <span className="avatar sm">{initials(answer.helperName)}</span>
            <b>{answer.helperName}</b>
            {answer.helperMajor && <span>{answer.helperMajor}</span>}
            <span>{relativeDate(answer.createdAt)}</span>
          </span>
          <p>{answer.text}</p>
        </div>
      ))}
      {answers.length === 0 && (asked.similar?.length ?? 0) > 0 && (
        <div className="students-similar">
          <span>Students answered something close already</span>
          {asked.similar!.map((entry) => (
            <p key={entry.text}>
              <b>{entry.text}</b> {entry.answer}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** A question another student is waiting on, picked for this student's major and year, answerable right here. */
function CanYouAnswer() {
  const { profile, setProfile, boardProblem, toast } = useApp();
  const [question, setQuestion] = useState<Question | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);
  const netId = profile?.netId;

  const load = useCallback(() => {
    if (!netId || boardProblem) return;
    api.board
      .next(netId, askerKey())
      .then((result) => setQuestion(result.question))
      .catch(() => setQuestion(null));
  }, [netId, boardProblem]);
  useEffect(load, [load]);

  if (!question || !profile) return null;

  const done = () => {
    setWriting(false);
    setText('');
    setQuestion(null);
  };
  const send = async () => {
    if (text.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      const result = await api.board.answer({ netId: profile.netId, questionId: question.id, text: text.trim(), anonymous });
      setProfile({ ...profile, answers: result.answered });
      toast('Thanks. They will see your answer in Ask.');
      done();
    } catch (error) {
      toast(error instanceof ApiError || error instanceof Error ? error.message : 'Could not send the answer.');
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    void api.board.skip({ netId: profile.netId, questionId: question.id }).then(load, () => undefined);
    done();
  };

  return (
    <section className="can-answer" data-line="questions" aria-labelledby="can-answer-title">
      <div className="can-answer-head">
        <span id="can-answer-title">Can you answer?</span>
        <span className="faint small">{relativeDate(question.createdAt)}</span>
        <AdminRemove type="question" id={question.id} label={question.text} compact onRemoved={done} />
      </div>
      <p className="can-answer-q">{question.text}</p>
      {writing ? (
        <div className="can-answer-form">
          <textarea
            className="input"
            rows={3}
            maxLength={1200}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="What you know: be specific, and say when it was"
            aria-label="Your answer"
            autoFocus
          />
          <label className="check">
            <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /> Answer without my name
          </label>
          <div className="can-answer-actions">
            <button type="button" className="btn ghost sm" onClick={() => setWriting(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary sm" onClick={() => void send()} disabled={busy || text.trim().length < 2}>
              {busy ? 'Sending' : 'Send answer'}
            </button>
          </div>
        </div>
      ) : (
        <div className="can-answer-actions">
          <button type="button" className="btn ghost sm" onClick={skip}>
            Not me
          </button>
          <button type="button" className="btn sm" onClick={() => setWriting(true)}>
            <IconChat /> Answer
          </button>
        </div>
      )}
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
