import type { ReactNode } from 'react';

/** What a list shows when it has nothing in it: the end of the line, one sentence on what stops here, and the way to add the first one. */
export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="terminus">
      <div className="terminus-mark" aria-hidden="true">
        <span className="terminus-ring">{icon}</span>
      </div>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {children && <div className="terminus-actions">{children}</div>}
    </div>
  );
}
