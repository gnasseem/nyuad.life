interface Props<T extends string> {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange(value: T): void;
  label: string;
}

export function Segmented<T extends string>({ value, options, onChange, label }: Props<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={value === option.id ? 'on' : undefined} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
