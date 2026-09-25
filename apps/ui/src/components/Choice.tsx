import { type ReactNode } from 'react';

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

export function Choice<T extends string>({ label, value, options, disabled = false, onChange }: ChoiceProps<T>): ReactNode {
  return (
    <span className="choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={option.value === value ? 'choice-opt is-on' : 'choice-opt'}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
