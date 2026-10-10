import { useEffect, useMemo, useRef, useState } from 'react';
import { IconClose, IconPlus, IconSearch, IconTrash } from '../icons';
import { navigate, onLinkClick } from '../router';
import { clearConversations, deleteConversation, setActiveConversation, type Conversation } from '../store';

const GROUPS: Array<{ label: string; days: number }> = [
  { label: 'Today', days: 1 },
  { label: 'Yesterday', days: 2 },
  { label: 'Previous 7 days', days: 7 },
  { label: 'Previous 30 days', days: 30 },
  { label: 'Older', days: Infinity },
];

/** Conversations grouped by how long ago they were last used, newest first. */
function grouped(conversations: Conversation[], now = new Date()): Array<{ label: string; items: Conversation[] }> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out = GROUPS.map((group) => ({ label: group.label, items: [] as Conversation[] }));
  for (const conversation of conversations) {
    const updated = Date.parse(conversation.updatedAt) || 0;
    const daysAgo = updated >= midnight ? 0 : Math.floor((midnight - updated) / 86_400_000) + 1;
    const index = GROUPS.findIndex((group) => daysAgo < group.days);
    out[index < 0 ? out.length - 1 : index]!.items.push(conversation);
  }
  return out.filter((group) => group.items.length);
}

/**
 * Past conversations down the left of Ask, like a chat app: new question at the top, then each conversation by when
 * it was last used. On a wide screen it sits beside the conversation and can be folded away; on a phone it slides in
 * over the page.
 */
export function HistoryPanel({ conversations, current, open, onClose }: { conversations: Conversation[]; current: string | null; open: boolean; onClose(): void }) {
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLElement>(null);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = words.length ? conversations.filter((conversation) => words.every((word) => `${conversation.title} ${conversation.messages.map((message) => message.content).join(' ')}`.toLowerCase().includes(word))) : conversations;
    return grouped(matching);
  }, [conversations, query]);

  useEffect(() => {
    if (!open) return;
    const mobile = window.matchMedia('(max-width: 1099px)').matches;
    if (!mobile) return;
    const before = document.activeElement as HTMLElement | null;
    const body = document.querySelector<HTMLElement>('.ask-body');
    body?.setAttribute('inert', '');
    (panel.current?.querySelector<HTMLInputElement>('input') ?? panel.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button, a, input') ?? [])];
      const first = items[0];
      const last = items.at(-1);
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      body?.removeAttribute('inert');
      document.removeEventListener('keydown', onKey);
      before?.focus();
    };
  }, [open, onClose]);

  const startNew = () => {
    setActiveConversation(null);
    navigate({ name: 'ask' });
    if (window.matchMedia('(max-width: 1099px)').matches) onClose();
  };

  const remove = (id: string) => {
    deleteConversation(id);
    if (current === id) navigate({ name: 'ask' });
  };

  const clearAll = () => {
    if (!window.confirm('Delete all saved conversations?')) return;
    clearConversations();
    if (current) navigate({ name: 'ask' });
  };

  return (
    <>
      <div className="history-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={panel} id="conversation-history" inert={!open} role={open && window.matchMedia('(max-width: 1099px)').matches ? 'dialog' : undefined} aria-modal={open && window.matchMedia('(max-width: 1099px)').matches ? true : undefined} className="history-panel" aria-label="Your conversations">
        <div className="hp-title"><h2>History</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close history"><IconClose /></button></div>
        <div className="hp-head">
          <button type="button" className="hp-new" onClick={startNew}>
            <IconPlus /> New question
          </button>
        </div>
        {conversations.length > 0 && (
          <div className="search-field hp-search">
            <IconSearch />
            <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
          </div>
        )}
        <nav className="hp-list">
          {conversations.length === 0 ? (
            <div className="hp-empty"><IconSearch /><p>Your conversations will appear here.</p><span>Ask a question to get started.</span></div>
          ) : shown.length === 0 ? (
            <p className="hp-empty">Nothing matches.</p>
          ) : (
            shown.map((group) => (
              <div key={group.label} className="hp-group">
                <span className="hp-label">{group.label}</span>
                {group.items.map((conversation) => (
                  <div key={conversation.id} className={`hist-item${current === conversation.id ? ' active' : ''}`}>
                    <a
                      href={`/?c=${conversation.id}`}
                      onClick={(event) => {
                        onLinkClick(event);
                        if (window.matchMedia('(max-width: 1099px)').matches) onClose();
                      }}
                      title={conversation.title}
                      aria-current={current === conversation.id ? 'page' : undefined}
                    >
                      <b>{conversation.title || 'Untitled'}</b><span className="hist-preview">{conversation.messages.filter((message) => message.role === 'model').at(-1)?.content.replace(/[*#`\[\]]/g, '').slice(0, 100) || 'Open conversation'}</span>
                    </a>
                    <button type="button" onClick={() => remove(conversation.id)} aria-label={`Delete "${conversation.title}"`}>
                      <IconTrash />
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </nav>
        {conversations.length > 0 && (
          <div className="hp-foot">
            <span title="Conversations are kept in this browser only">
              {conversations.length} saved here
            </span>
            <button type="button" className="link-btn small" onClick={clearAll}>
              Clear all
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
