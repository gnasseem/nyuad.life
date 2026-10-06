import { useEffect, useMemo, useState } from 'react';
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
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = words.length ? conversations.filter((conversation) => words.every((word) => `${conversation.title} ${conversation.messages.map((message) => message.content).join(' ')}`.toLowerCase().includes(word))) : conversations;
    return grouped(matching);
  }, [conversations, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && window.matchMedia('(max-width: 1099px)').matches && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
      <aside className="history-panel" aria-label="Your conversations">
        <div className="hp-head">
          <button type="button" className="hp-new" onClick={startNew}>
            <IconPlus /> New question
          </button>
          <button type="button" className="icon-btn hp-close" onClick={onClose} aria-label="Hide conversations" title="Hide conversations">
            <IconClose />
          </button>
        </div>
        {conversations.length > 6 && (
          <div className="search-field hp-search">
            <IconSearch />
            <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
          </div>
        )}
        <nav className="hp-list">
          {conversations.length === 0 ? (
            <p className="hp-empty">Your questions will be listed here.</p>
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
                      <b>{conversation.title || 'Untitled'}</b>
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
