import type { SVGProps } from 'react';
import { APP_NAME } from '../brand';

/**
 * The mark: two rounded squares, one turned 45°, make the eight-point star that is cut into the mashrabiya screens
 * all over campus; the dot in the middle is the dot in nyuad.life. Outline by default, solid on a gradient tile
 * for the favicon, the welcome card and the answer avatar.
 */
export function Mark({ solid = false, ...props }: SVGProps<SVGSVGElement> & { solid?: boolean }) {
  if (solid) {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true" {...props}>
        <defs>
          <linearGradient id="life-g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6c3de0" />
            <stop offset="0.5" stopColor="#c04ac7" />
            <stop offset="1" stopColor="#f5a524" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#life-g)" />
        <g fill="#fffdf9">
          <rect x="16" y="16" width="32" height="32" rx="8" />
          <rect x="16" y="16" width="32" height="32" rx="8" transform="rotate(45 32 32)" />
        </g>
        <circle cx="32" cy="32" r="5.5" fill="url(#life-g)" />
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

/** The mark and the name side by side, with the dot in the name picked out in the accent colour. */
export function Wordmark({ solid = false }: { solid?: boolean }) {
  const [left, right] = APP_NAME.split('.');
  return (
    <span className="wordmark-inner">
      <Mark solid={solid} className="wordmark-mark" />
      <span className="wordmark-text">
        {left}
        <i>.</i>
        {right}
      </span>
    </span>
  );
}
