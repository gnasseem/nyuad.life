import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Props<T extends string> {
  value: T;
  options: Array<{ id: T; label: ReactNode; count?: number }>;
  onChange(value: T): void;
  label: string;
  /** "pill" is a compact switch; "tabs" is a row of tabs with an underline. */
  variant?: 'pill' | 'tabs';
}

/** A set of options where the chosen one is marked by a thumb that slides between them. */
export function Segmented<T extends string>({ value, options, onChange, label, variant = 'pill' }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  // The thumb only slides once it has been placed, so it does not fly in from the left on the first paint.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const active = element.querySelector<HTMLElement>('[aria-selected="true"]');
      setThumb(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, options.map((option) => `${option.id}:${option.count ?? ''}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = options.findIndex((option) => option.id === value);
    const next = options[(index + (event.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
    onChange(next.id);
    window.requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <div ref={ref} className={variant === 'tabs' ? 'tabs' : 'segmented'} role="tablist" aria-label={label} onKeyDown={onKey}>
      {thumb && <span className={`thumb${ready ? ' animate' : ''}`} style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }} aria-hidden="true" />}
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          tabIndex={value === option.id ? 0 : -1}
          className={value === option.id ? 'on' : undefined}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== undefined && option.count > 0 && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
