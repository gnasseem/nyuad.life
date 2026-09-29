import { useState } from 'react';
import { relativeDate } from '../format';
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
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 className="display">Your questions</h1>
          <p>Saved on this device only. Open one to keep the conversation going.</p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={clear}>
            Clear all
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <h3>Nothing yet</h3>
          Questions you ask will show up here.
        </div>
      ) : (
        <div className="post-list">
          {items.map((conversation) => (
            <div key={conversation.id} className="history-item">
              <button type="button" className="title" onClick={() => navigate({ name: 'ask' }, { search: `c=${conversation.id}` })}>
                {conversation.title}
              </button>
              <span className="faint small">
                {Math.floor(conversation.messages.length / 2)} Q · {relativeDate(conversation.updatedAt)}
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
