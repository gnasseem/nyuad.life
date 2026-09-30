import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from '../icons';

interface Props {
  open: boolean;
  onClose(): void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** A small figure above the title, such as the mark. */
  eyebrow?: ReactNode;
  children: ReactNode;
  width?: number;
  /** When false the card has no close button and clicking outside does nothing; the content must offer a way out. */
  dismissible?: boolean;
  /** Hides the divider and padding around the body, for content that brings its own. */
  bare?: boolean;
}

/** A centred sheet over a blurred scrim. Escape closes it, focus goes to the first field, the page stops scrolling. */
export function Modal({ open, onClose, title, subtitle, eyebrow, children, width = 520, dismissible = true, bare = false }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) onClose();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const first = cardRef.current?.querySelector<HTMLElement>('input, textarea, select, button.primary, [autofocus]');
      first?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && dismissible && onClose()} role="presentation">
      <div ref={cardRef} className={`modal${bare ? ' bare' : ''}`} style={{ width: `min(${width}px, 100%)` }} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        {dismissible && (
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        )}
        {(eyebrow || title || subtitle) && (
          <div className="modal-head">
            {eyebrow}
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
