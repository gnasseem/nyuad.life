import type { Redirect } from '../api';
import { IconArrow } from '../icons';
import { onLinkClick } from '../router';

/** Where to take a request the archive should not answer: a page on this site, or the group. */
export function RedirectCard({ redirect }: { redirect: Redirect }) {
  const internal = redirect.link.url.startsWith('/');
  return (
    <div className="redirect">
      <h3>{redirect.title}</h3>
      <p>{redirect.message}</p>
      <a className="btn primary sm" href={redirect.link.url} target={internal ? undefined : '_blank'} rel="noreferrer" onClick={internal ? onLinkClick : undefined}>
        {redirect.link.label} <IconArrow />
      </a>
    </div>
  );
}
