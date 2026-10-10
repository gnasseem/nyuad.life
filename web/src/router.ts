import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export type Route =
  | { name: 'ask' }
  | { name: 'questions' }
  | { name: 'question'; id: string }
  | { name: 'announcements' }
  | { name: 'post'; id: string }
  | { name: 'market'; tab: MarketTab }
  | { name: 'courses'; code?: string }
  | { name: 'professors'; nameQuery?: string }
  | { name: 'threads' }
  | { name: 'plan' }
  | { name: 'settings' }
  | { name: 'admin' };

export type MarketTab = 'items' | 'falcons' | 'campus' | 'rides';
const MARKET_TABS: MarketTab[] = ['items', 'falcons', 'campus', 'rides'];

export function parseRoute(pathname: string): Route {
  // A malformed escape ("/post/%E0") would throw outside every error boundary and leave a blank page; keep it as typed.
  const parts = pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  switch (parts[0]) {
    case 'questions':
      return parts[1] ? { name: 'question', id: parts[1] } : { name: 'questions' };
    case 'events':
    case 'announcements':
    case 'notices':
      return { name: 'announcements' };
    case 'courses':
      return { name: 'courses', code: parts[1] };
    case 'professors':
      return { name: 'professors', nameQuery: parts[1] };
    case 'threads':
      return { name: 'threads' };
    case 'plan':
      return { name: 'plan' };
    // Old links: the archive and the guide became the course search and the thread search.
    case 'archive':
    case 'browse':
    case 'guide':
      if (parts[1] === 'threads') return { name: 'threads' };
      return parts[1] === 'courses' && parts[2] ? { name: 'courses', code: parts[2] } : { name: 'courses' };
    case 'post':
      return parts[1] ? { name: 'post', id: parts[1] } : { name: 'threads' };
    case 'settings':
      return { name: 'settings' };
    case 'admin':
      return { name: 'admin' };
    case 'falcons':
      return { name: 'market', tab: 'falcons' };
    case 'market':
      return { name: 'market', tab: MARKET_TABS.includes(parts[1] as MarketTab) ? (parts[1] as MarketTab) : 'items' };
    default:
      return { name: 'ask' };
  }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'ask':
      return '/';
    case 'questions':
      return '/questions';
    case 'question':
      return `/questions/${encodeURIComponent(route.id)}`;
    case 'announcements':
      return '/events';
    case 'post':
      return `/post/${encodeURIComponent(route.id)}`;
    case 'settings':
      return '/settings';
    case 'admin':
      return '/admin';
    case 'market':
      return route.tab === 'items' ? '/market' : `/market/${route.tab}`;
    case 'courses':
      return route.code ? `/courses/${encodeURIComponent(route.code)}` : '/courses';
    case 'professors':
      return route.nameQuery ? `/professors/${encodeURIComponent(route.nameQuery)}` : '/professors';
    case 'threads':
      return '/threads';
    case 'plan':
      return '/plan';
  }
}

const listeners = new Set<() => void>();

export function navigate(route: Route, options: { replace?: boolean; search?: string; keepScroll?: boolean; state?: unknown } = {}): void {
  const url = routePath(route) + (options.search ? `?${options.search}` : '');
  const commit = () => {
    if (options.replace) window.history.replaceState(options.state ?? null, '', url);
    else window.history.pushState(options.state ?? null, '', url);
    listeners.forEach((listener) => listener());
    if (!options.keepScroll) window.scrollTo({ top: 0 });
  };
  if (!options.replace && changesPage(parseRoute(window.location.pathname), route) && canTransition()) document.startViewTransition(() => flushSync(commit));
  else commit();
}

/** A new page, not a panel opening over the same one, gets the cross-fade. */
function changesPage(from: Route, to: Route): boolean {
  if (from.name !== to.name) return true;
  if (from.name === 'courses' && to.name === 'courses') return false;
  if ((from.name === 'post' && to.name === 'post') || (from.name === 'question' && to.name === 'question')) return from.id !== to.id;
  return false;
}

function canTransition(): boolean {
  return typeof document.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useRoute(): { route: Route; search: URLSearchParams } {
  const read = () => ({ route: parseRoute(window.location.pathname), search: new URLSearchParams(window.location.search) });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return state;
}

/** Intercepts plain <a href="/..."> clicks so they use the in-app router. */
export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement | SVGAElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  event.preventDefault();
  const url = new URL(href, window.location.origin);
  navigate(parseRoute(url.pathname), { search: url.search.slice(1) });
}
