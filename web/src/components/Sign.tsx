import type { ReactNode } from 'react';

/** A page title set as a station sign: the name, its Arabic, and the line running on to the page's actions. */
export function Sign({ title, ar, children }: { title: string; ar?: string; children?: ReactNode }) {
  return (
    <div className="sign">
      <div className="sign-name">
        <h1>{title}</h1>
        {ar && (
          <span className="sign-ar" lang="ar" dir="rtl">
            {ar}
          </span>
        )}
      </div>
      <span className="sign-line" aria-hidden="true" />
      {children && <div className="sign-actions">{children}</div>}
    </div>
  );
}
