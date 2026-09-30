import { useEffect, useState } from 'react';

export type Route =
  | { name: 'ask' }
  | { name: 'questions' }
  | { name: 'question'; id: string }
  | { name: 'announcements' }
  | { name: 'browse' }
  | { name: 'post'; id: string }
  | { name: 'courses'; code?: string }
  | { name: 'falcons' }
  | { name: 'guide'; section?: string; id?: string }
  | { name: 'settings' };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'questions':
      return parts[1] ? { name: 'question', id: parts[1] } : { name: 'questions' };
    case 'announcements':
      return { name: 'announcements' };
    case 'archive':
    case 'browse':
      return parts[1] === 'courses' ? { name: 'guide', section: 'courses', id: parts[2] } : { name: 'guide' };
    case 'courses':
      return { name: 'guide', section: 'courses', id: parts[1] };
    case 'post':
      return parts[1] ? { name: 'post', id: parts[1] } : { name: 'browse' };
    case 'settings':
      return { name: 'settings' };
    case 'falcons':
      return { name: 'falcons' };
    case 'guide':
      return { name: 'guide', section: parts[1], id: parts[2] };
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
      return '/announcements';
    case 'browse':
      return '/archive';
    case 'post':
      return `/post/${encodeURIComponent(route.id)}`;
    case 'courses':
      return route.code ? `/archive/courses/${encodeURIComponent(route.code)}` : '/archive/courses';
    case 'settings':
      return '/settings';
    case 'falcons':
      return '/falcons';
    case 'guide':
      return route.section ? (route.id ? `/guide/${encodeURIComponent(route.section)}/${encodeURIComponent(route.id)}` : `/guide/${encodeURIComponent(route.section)}`) : '/guide';
  }
}

const listeners = new Set<() => void>();

export function navigate(route: Route, options: { replace?: boolean; search?: string; keepScroll?: boolean } = {}): void {
  const url = routePath(route) + (options.search ? `?${options.search}` : '');
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  listeners.forEach((listener) => listener());
  if (!options.keepScroll) window.scrollTo({ top: 0 });
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
export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  event.preventDefault();
  const url = new URL(href, window.location.origin);
  navigate(parseRoute(url.pathname), { search: url.search.slice(1) });
}
