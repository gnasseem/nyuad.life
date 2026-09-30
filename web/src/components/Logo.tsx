import type { SVGProps } from 'react';
import { APP_NAME } from '../brand';

/**
 * The mark: two rounded squares, one turned 45°, make the eight-point star cut into the mashrabiya screens across
 * campus; the dot in the middle is the dot in nyuad.life. One colour, so it sits in any UI like a system icon.
 * `tile` puts it in white on an ink square (favicon, avatars).
 */
export function Mark({ tile = false, ...props }: SVGProps<SVGSVGElement> & { tile?: boolean }) {
  if (tile) {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true" {...props}>
        <rect width="64" height="64" rx="14" fill="currentColor" />
        <g fill="none" stroke="var(--tile-fg, #fff)" strokeWidth="4" strokeLinejoin="round">
          <rect x="17" y="17" width="30" height="30" rx="7" />
          <rect x="17" y="17" width="30" height="30" rx="7" transform="rotate(45 32 32)" />
        </g>
        <circle cx="32" cy="32" r="4.5" fill="var(--tile-fg, #fff)" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="14" y="14" width="36" height="36" rx="9" />
      <rect x="14" y="14" width="36" height="36" rx="9" transform="rotate(45 32 32)" />
      <circle cx="32" cy="32" r="5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The mark and the name side by side. */
export function Wordmark() {
  const [left, right] = APP_NAME.split('.');
  return (
    <span className="wordmark-inner">
      <Mark tile className="wordmark-mark" />
      <span className="wordmark-text">
        {left}
        <i>.</i>
        {right}
      </span>
    </span>
  );
}
