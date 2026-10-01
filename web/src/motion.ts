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
