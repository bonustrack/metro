import { type CSSProperties, type ReactNode, useState } from 'react';
import { FONT_SIZE } from '../tokens';
import { usePalette } from '../theme-context';
import { type Palette } from '../palette';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps {
  variant?: Variant;
  size?: Size;
  active?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const HEIGHT: Record<Size, number> = { sm: 32, md: 40 };
const PADDING: Record<Size, number> = { sm: 12, md: 16 };
const FONT: Record<Size, number> = { sm: FONT_SIZE.sm, md: FONT_SIZE.md };

function background(p: Palette, variant: Variant, filled: boolean): string {
  if (variant === 'primary') return p.primary;
  if (variant === 'ghost') return filled ? p.hover : 'transparent';
  return filled ? p.hover : p.inputBg;
}

function border(p: Palette, variant: Variant, active: boolean): string {
  if (variant === 'primary') return 'none';
  return `1px solid ${active ? p.text : p.border}`;
}

function foreground(p: Palette, variant: Variant, active: boolean): string {
  if (variant === 'primary') return p.onPrimary;
  return active ? p.head : p.text;
}

interface StyleArgs {
  p: Palette;
  variant: Variant;
  size: Size;
  active: boolean;
  disabled: boolean;
  hover: boolean;
}

function buttonStyle({ p, variant, size, active, disabled, hover }: StyleArgs): CSSProperties {
  const filled = active || (variant !== 'ghost' && hover && !disabled);
  return {
    height: HEIGHT[size],
    padding: `0 ${String(PADDING[size])}px`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 999,
    border: border(p, variant, active),
    background: background(p, variant, filled),
    color: foreground(p, variant, active),
    fontFamily: p.fontHead,
    fontWeight: 600,
    fontSize: FONT[size],
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    whiteSpace: 'nowrap',
    transition: 'background 0.12s ease, color 0.12s ease',
  };
}

export function Button({
  variant = 'secondary',
  size = 'md',
  active = false,
  disabled = false,
  type = 'button',
  onClick,
  title,
  style,
  children,
}: ButtonProps): ReactNode {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => { setHover(true); }}
      onMouseLeave={() => { setHover(false); }}
      style={{ ...buttonStyle({ p, variant, size, active, disabled, hover }), ...style }}
    >
      {children}
    </button>
  );
}
