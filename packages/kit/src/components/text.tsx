import { type CSSProperties, type ReactNode } from 'react';
import { FONT_SIZE, type FontSizeName } from '../tokens';
import { usePalette } from '../theme-context';

type Role = 'head' | 'body' | 'sub' | 'danger' | 'success';
type Weight = 'medium' | 'semibold';

interface TextProps {
  size?: FontSizeName;
  role?: Role;
  weight?: Weight;
  mono?: boolean;
  as?: 'span' | 'p' | 'div';
  style?: CSSProperties;
  children: ReactNode;
}

export function Text({
  size = 'md',
  role = 'body',
  weight = 'medium',
  mono = false,
  as = 'span',
  style,
  children,
}: TextProps): ReactNode {
  const p = usePalette();
  const color: Record<Role, string> = {
    head: p.head,
    body: p.text,
    sub: p.sub,
    danger: p.danger,
    success: p.success,
  };
  const Tag = as;
  return (
    <Tag
      style={{
        margin: 0,
        color: color[role],
        fontSize: FONT_SIZE[size],
        fontFamily: mono ? p.fontMono : weight === 'semibold' ? p.fontHead : p.fontSans,
        fontWeight: weight === 'semibold' ? 600 : 500,
        lineHeight: 1.5,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
