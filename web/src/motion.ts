import { useEffect, useRef, useState } from 'react';

/** Keeps something mounted for `ms` after it closes, so it can play its exit animation. */
export function usePresence(open: boolean, ms = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** The last value that was not undefined, so a closing panel keeps showing what it showed. */
export function useLatest<T>(value: T | undefined): T | undefined {
  const ref = useRef(value);
  if (value !== undefined) ref.current = value;
  return ref.current;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Whether a media query matches, kept up to date as the window changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    onChange();
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The current time, refreshed every `ms`, so countdowns like "In 12 min" stay true while the page is open. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** The time on Saadiyat, whatever the reader's own clock says. */
export function useAbuDhabiTime(): string {
  const format = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });
  const [time, setTime] = useState(format);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(format()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return time;
}
