import { useEffect, useState } from 'react';

export type Route =
  | { name: 'ask' }
  | { name: 'browse' }
  | { name: 'post'; id: string }
  | { name: 'courses'; code?: string }
  | { name: 'history' };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'browse':
      return { name: 'browse' };
    case 'post':
      return parts[1] ? { name: 'post', id: parts[1] } : { name: 'browse' };
    case 'courses':
      return { name: 'courses', code: parts[1] };
    case 'history':
      return { name: 'history' };
    default:
      return { name: 'ask' };
  }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'ask':
      return '/';
    case 'browse':
      return '/browse';
    case 'post':
      return `/post/${encodeURIComponent(route.id)}`;
    case 'courses':
      return route.code ? `/courses/${encodeURIComponent(route.code)}` : '/courses';
    case 'history':
      return '/history';
  }
}

const listeners = new Set<() => void>();

export function navigate(route: Route, options: { replace?: boolean; search?: string } = {}): void {
  const url = routePath(route) + (options.search ? `?${options.search}` : '');
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  listeners.forEach((listener) => listener());
  window.scrollTo({ top: 0 });
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
