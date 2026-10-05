import type { SVGProps } from 'react';
import { APP_NAME } from '../brand';

/** Two rounded squares, one turned 45°: the eight-point star from the campus mashrabiya, with the dot from the domain name. */
export function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="4.4" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="14" y="14" width="36" height="36" rx="3.5" />
      <rect x="14" y="14" width="36" height="36" rx="3.5" transform="rotate(45 32 32)" />
      <circle cx="32" cy="32" r="5.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The mark and the domain, with the dot in the colour of the line you are on. */
export function Wordmark() {
  const [left, right] = APP_NAME.split('.');
  return (
    <>
      <Mark className="brand-mark" />
      <span className="brand-name">
        {left}
        <i>.</i>
        {right}
      </span>
    </>
  );
}
