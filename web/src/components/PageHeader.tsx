import type { ReactNode } from 'react';

/** The top of a page: its title, an optional line on what it is for, and the page's actions on the right. */
export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
