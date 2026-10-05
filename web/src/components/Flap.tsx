import type { CSSProperties } from 'react';

/**
 * Text set like a split-flap departure board: each character flips down into place, one after another. Characters are
 * keyed by position and value, so when the text changes ("In 12 min" to "In 11 min") only the changed ones flip.
 */
export function Flap({ text }: { text: string }) {
  return (
    <span className="flap" aria-label={text}>
      {[...text].map((char, index) => (
        <span key={`${index}-${char}`} aria-hidden="true" style={{ '--d': index } as CSSProperties}>
          {char}
        </span>
      ))}
    </span>
  );
}
