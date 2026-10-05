import type { ReactNode } from 'react';

/** What a list shows when it has nothing in it: one sentence on what goes here, and the way to add the first one. */
export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
