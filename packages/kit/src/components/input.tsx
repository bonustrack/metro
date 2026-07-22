import { type CSSProperties, type ReactNode, useState } from 'react';
import { FONT_SIZE } from '../tokens';
import { usePalette } from '../theme-context';

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'search' | 'date' | 'password';
  ariaLabel?: string;
  autoFocus?: boolean;
  style?: CSSProperties;
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  ariaLabel,
  autoFocus = false,
  style,
}: InputProps): ReactNode {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={type}
      value={value}
      aria-label={ariaLabel ?? placeholder}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => { onChange(e.target.value); }}
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); }}
      style={{
        height: 40,
        minWidth: 0,
        width: '100%',
        padding: '0 14px',
        borderRadius: 12,
        border: `1px solid ${focused ? p.text : p.border}`,
        background: p.inputBg,
        color: p.head,
        fontFamily: p.fontSans,
        fontWeight: 500,
        fontSize: FONT_SIZE.md,
        outline: 'none',
        colorScheme: p.scheme,
        boxSizing: 'border-box',
        ...style,
      }}
    />
  );
}
