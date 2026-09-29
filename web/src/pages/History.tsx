import { useState } from 'react';
import { plural, relativeDate } from '../format';
import { IconTrash } from '../icons';
import { navigate } from '../router';
import { clearConversations, deleteConversation, loadConversations } from '../store';

export function HistoryPage() {
  const [items, setItems] = useState(loadConversations);

  const remove = (id: string) => {
    deleteConversation(id);
    setItems(loadConversations());
  };
  const clear = () => {
    if (!window.confirm('Delete all saved questions on this device?')) return;
    clearConversations();
    setItems([]);
  };

  return (
    <div className="page">
      <div className="page-head split">
        <div>
          <h1>Your questions</h1>
          <p>Saved in this browser only. Open one to continue the conversation.</p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn sm" onClick={clear}>
            Clear all
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <h3>Nothing yet</h3>
          Questions you ask will be listed here.
        </div>
      ) : (
        <div className="post-list">
          {items.map((conversation) => (
            <div key={conversation.id} className="history-item">
              <button type="button" className="title" onClick={() => navigate({ name: 'ask' }, { search: `c=${conversation.id}` })}>
                {conversation.title}
              </button>
              <span className="faint small">
                {plural(Math.floor(conversation.messages.length / 2), 'question')} · {relativeDate(conversation.updatedAt)}
              </span>
              <button type="button" className="btn ghost icon sm" onClick={() => remove(conversation.id)} aria-label="Delete">
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
