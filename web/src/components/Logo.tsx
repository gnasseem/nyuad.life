import type { SVGProps } from 'react';
import { APP_NAME } from '../brand';

/** Two rounded squares, one turned 45°: the eight-point star from the campus mashrabiya, with the dot from the domain name. */
function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="14" y="14" width="36" height="36" rx="9" />
      <rect x="14" y="14" width="36" height="36" rx="9" transform="rotate(45 32 32)" />
      <circle cx="32" cy="32" r="5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark-inner">
      <Mark className="wordmark-mark" />
      <span className="wordmark-text">{APP_NAME}</span>
    </span>
  );
}
