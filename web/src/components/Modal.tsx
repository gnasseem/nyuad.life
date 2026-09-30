import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from '../icons';

interface Props {
  open: boolean;
  onClose(): void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: number;
}

/** A centred sheet over a scrim. Escape closes it, focus goes to the first field, the page stops scrolling. */
export function Modal({ open, onClose, title, subtitle, children, width = 520 }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => cardRef.current?.querySelector<HTMLElement>('input, textarea, select, button.primary')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <div ref={cardRef} className="modal" style={{ width: `min(${width}px, 100%)` }} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
