import type { ReactNode } from 'react';

/** A page's header: its name in the section's colour, the Arabic beside it, an optional line under it, and its actions. */
export function Sign({ title, ar, sub, children }: { title: string; ar?: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="ph-text">
        <div className="ph-name">
          <span className="ph-dot" aria-hidden="true" />
          <h1>{title}</h1>
          {ar && (
            <span className="ph-ar" lang="ar" dir="rtl">
              {ar}
            </span>
          )}
        </div>
        {sub && <p className="ph-sub">{sub}</p>}
      </div>
      {children && <div className="ph-actions">{children}</div>}
    </header>
  );
}
