import type { Redirect } from '../api';
import { IconArrow } from '../icons';
import { onLinkClick } from '../router';

/**
 * Where to take a request the archive should not answer: a page on this site, or the group. With `onAction` the button
 * does the thing in place (asking students) instead of following the link.
 */
export function RedirectCard({ redirect, onAction, busy = false }: { redirect: Redirect; onAction?(): void; busy?: boolean }) {
  const internal = redirect.link.url.startsWith('/');
  const line = redirect.link.url.startsWith('/market') ? 'market' : (redirect.link.url.startsWith('/events') || redirect.link.url.startsWith('/notices')) ? 'notices' : redirect.domain === 'live' ? 'questions' : 'guide';
  return (
    <div className="redirect" data-line={line}>
      <h3>{redirect.title}</h3>
      <p>{redirect.message}</p>
      {onAction ? (
        <button type="button" className="btn primary sm" onClick={onAction} disabled={busy}>
          {busy ? 'Asking students…' : redirect.link.label} <IconArrow className="go" />
        </button>
      ) : (
        <a className="btn primary sm" href={redirect.link.url} target={internal ? undefined : '_blank'} rel="noreferrer" onClick={internal ? onLinkClick : undefined}>
          {redirect.link.label} <IconArrow className="go" />
        </a>
      )}
    </div>
  );
}
