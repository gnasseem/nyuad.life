import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from '../icons';
import { usePresence } from '../motion';

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
  // Callers pass a fresh onClose each render; the effect below should run once per opening, not on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { mounted, closing } = usePresence(open, 180);
  // While closing, keep showing what was there, since callers usually clear the content as they close.
  const shown = useRef({ title, subtitle, children });
  if (open) shown.current = { title, subtitle, children };

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const card = cardRef.current;
      (card?.querySelector<HTMLElement>('[data-autofocus]') ?? card?.querySelector<HTMLElement>('input, textarea, select, button.primary'))?.focus({ preventScroll: true });
    }, 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      window.clearTimeout(timer);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;
  return createPortal(
    <div className={`modal-scrim${closing ? ' closing' : ''}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <div ref={cardRef} className="modal" style={{ width: `min(${width}px, 100%)` }} role="dialog" aria-modal="true" aria-label={shown.current.title}>
        <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
        <div className="modal-head">
          <h2>{shown.current.title}</h2>
          {shown.current.subtitle && <p>{shown.current.subtitle}</p>}
        </div>
        <div className="modal-body">{shown.current.children}</div>
      </div>
    </div>,
    document.body,
  );
}
