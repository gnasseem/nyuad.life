import type { ReactNode } from 'react';

interface Props<T extends string> {
  value: T;
  options: Array<{ id: T; label: ReactNode; count?: number }>;
  onChange(value: T): void;
  label: string;
}

export function Segmented<T extends string>({ value, options, onChange, label }: Props<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={value === option.id ? 'on' : undefined} onClick={() => onChange(option.id)}>
          {option.label}
          {option.count !== undefined && option.count > 0 && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
